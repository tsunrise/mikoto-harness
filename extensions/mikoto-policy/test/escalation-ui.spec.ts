import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MikotoEscalationResult } from "mikoto-types";
import { visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { EscalationComponent, inertText, registerDecisionRenderer } from "../src/escalate/ui.ts";
import { keys, request, theme, tui } from "./escalation-fixtures.ts";

describe("escalation UI", () => {
  it("frames the dialog in the purple message palette, highlights Reject, and keeps both states within bounds", () => {
    const colors: string[] = [];
    const styledTheme = {
      ...theme,
      fg(color: string, text: string) {
        colors.push(color);
        return `\x1b[35m${text}\x1b[39m`;
      },
      bg() { throw new Error("The panel must not paint a background"); },
      bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
      italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
      inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
    } as unknown as typeof theme;
    const terminal = { rows: 18 };
    const component = new EscalationComponent({
      ...request(), verb: "Apply Patch", subject: "[denied] /Users/tom/hello.txt",
      why: "This patch needs write access to paths denied by the current policy.",
    }, { ...tui, terminal } as typeof tui, styledTheme, keys(), () => {});
    component.focused = true;
    const lines = component.render(160);
    const text = lines.map(stripAnsi).join("\n");
    assert.match(text, /\n╭─+╮\n/);
    assert.match(text, /╰─+╯$/);
    assert.ok(text.includes("/Users/tom/hello.txt"));
    // All border rows have the same width even in terminals that render the
    // torii in one cell. The emoji is confined to the standalone title.
    assert.ok(lines.slice(1).every((line) => visibleWidth(line) === 104));
    assert.ok(lines.slice(1).every((line) => !line.includes("⛩")));
    assert.ok(colors.includes("customMessageLabel"));
    assert.ok(!colors.includes("accent") && !colors.includes("warning"));
    const selection = (frame: string[]) =>
      [...frame.join("\n").matchAll(/\x1b\[7m(.*?)\x1b\[27m/g)].map((match) => stripAnsi(match[1]));
    const initialSelection = selection(lines);
    assert.equal(initialSelection.length, 1);
    assert.ok(initialSelection[0].trim());
    component.handleInput("\x1b[D");
    const movedSelection = selection(component.render(80));
    assert.equal(movedSelection.length, 1);
    assert.notDeepEqual(movedSelection, initialSelection);
    component.handleInput("\x1b[C");
    assert.deepEqual(selection(component.render(80)), initialSelection);

    for (const state of ["decision", "reason"]) {
      if (state === "reason") component.handleInput("\r");
      for (const rows of [12, 18, 30]) {
        terminal.rows = rows;
        for (const width of [1, 2, 4, 12, 40, 44, 60, 80, 160]) {
          component.invalidate();
          const rendered = component.render(width);
          assert.ok(rendered.every((line) => visibleWidth(line) <= width), `${state}: ${rows}×${width}`);
          assert.ok(rendered.length <= rows, `${state}: ${rows}×${width}`);
          if (state === "reason" && width >= 12) {
            assert.ok(rendered.join("\n").includes(CURSOR_MARKER));
          }
        }
      }
    }
  });

  it("uses configured actions, ignores printable approval and chunked paste, propagates IME focus", () => {
    const results: MikotoEscalationResult[] = [];
    const component = new EscalationComponent(request(), tui, theme,
      keys({ "tui.select.confirm": ["ctrl+y"] }), (result) => results.push(result));
    component.focused = true;
    component.handleInput("y");
    component.handleInput("\x1b[200~");
    component.handleInput("\x1b[D");
    component.handleInput("\x19");
    component.handleInput("\x1b[201~");
    assert.equal(results.length, 0);
    component.handleInput("\x19"); // default Reject -> reason.
    assert.ok(component.render(80).join("\n").includes(CURSOR_MARKER));
    component.handleInput("\x1b");
    assert.equal(results.length, 0);
    assert.ok(!component.render(80).join("\n").includes(CURSOR_MARKER));
    component.handleInput("\x19");
    component.handleInput("\r"); // Submit an empty reason.
    assert.deepEqual(results, [{ decision: "reject", cause: "user" }]);

    const printable = new EscalationComponent(request(), tui, theme,
      keys({ "tui.select.confirm": ["y"] }), (result) => results.push(result));
    printable.handleInput("\x1b[D");
    printable.handleInput("y");
    assert.equal(results.length, 1);
  });

  it("returns from the reason view without deciding, preserving draft, selection, scroll and focus", () => {
    const results: MikotoEscalationResult[] = [];
    const component = new EscalationComponent({
      ...request(), subject: Array.from({ length: 40 }, (_, i) => `/target/${i}`),
    }, tui, theme, keys({ "tui.select.cancel": ["ctrl+x"] }), (result) => results.push(result));
    component.focused = true;
    component.render(80);
    component.handleInput("\x1b[6~");
    const before = component.render(80);
    component.handleInput("\r");
    component.handleInput("Keep it private");
    assert.ok(component.render(80).join("\n").includes(CURSOR_MARKER));
    component.handleInput("\x18"); // Configured cancel goes back, too.
    assert.equal(results.length, 0);
    assert.deepEqual(component.render(80), before);
    component.handleInput("\r");
    assert.match(component.render(80).join("\n"), /Keep it private/);
    assert.ok(component.render(80).join("\n").includes(CURSOR_MARKER));
    component.handleInput("\x1b");
    component.handleInput("\x1b[D");
    component.handleInput("\r");
    assert.deepEqual(results, [{ decision: "approve" }]);
    component.handleInput("\r");
    assert.equal(results.length, 1);
  });

  it("scrolls the whole scope, escapes terminal/invisible text and respects narrow widths", () => {
    const subject = Array.from({ length: 50 }, (_, i) => `/path/${i}/${"x".repeat(100)}`);
    subject.push("\x1b]52;c;secrets\x07\u202e\u200b");
    const component = new EscalationComponent({ ...request(), subject }, tui, theme, keys(), () => {});
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      for (const line of component.render(40)) seen.add(line);
      component.handleInput("\x1b[6~");
    }
    assert.ok([...seen].some((line) => line.includes("/path/49/")));
    assert.ok([...seen].some((line) => line.includes("\\u{1b}]52")));
    assert.ok([...seen].every((line) => !/[\x1b\x07\u202e\u200b]/u.test(stripAnsi(line))));
    for (const width of [1, 2, 4, 12, 80]) {
      component.invalidate();
      assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    }
    assert.equal(inertText("\r\n\t"), "\\u{d}\\u{a}\\u{9}");
  });

  it("renders validated history only as inert, informational data", () => {
    let renderer: Parameters<ExtensionAPI["registerEntryRenderer"]>[1] | undefined;
    registerDecisionRenderer({
      registerEntryRenderer(_type: string, fn: NonNullable<typeof renderer>) { renderer = fn; },
    } as ExtensionAPI);
    assert.ok(renderer);
    const colors: string[] = [];
    const historyTheme = {
      ...theme,
      fg(color: string, text: string) { colors.push(color); return text; },
    } as unknown as typeof theme;
    const render = (data: unknown, expanded: boolean) =>
      renderer!({ data } as never, { expanded } as never, historyTheme)!.render(60).join("\n");
    const invalid = render({ version: 99 }, false);
    assert.ok(invalid.trim());
    const data = { version: 1, source: "test", requestId: "1", verb: "Apply Patch",
      subject: ["/a", "/b\x1b[31m"], why: "Needed", result: { decision: "approve" } };
    const approved = render(data, false);
    assert.ok(approved.includes(data.verb));
    assert.notEqual(approved, invalid);
    assert.equal(render(data, true), approved);
    assert.ok(!render(data, true).includes("/a"));
    const rejected = { ...data, result: { decision: "reject", cause: "user", reason: "Keep it private" } };
    const rejection = render(rejected, false);
    assert.ok(rejection.includes(data.verb));
    assert.notEqual(rejection, approved);
    assert.equal(render(rejected, true), rejection);
    assert.ok(!render(rejected, true).includes("Keep it private"));
    const unavailable = { ...data, result: { decision: "reject", cause: "unavailable" } };
    const failure = render(unavailable, false);
    assert.ok(failure.includes(data.verb));
    assert.notEqual(failure, rejection);
    assert.ok(!failure.includes("/b"));
    assert.doesNotMatch([approved, rejection, failure].join("\n"), /\x1b/);
    assert.deepEqual(new Set(colors), new Set(["customMessageLabel", "muted"]));
  });
});
