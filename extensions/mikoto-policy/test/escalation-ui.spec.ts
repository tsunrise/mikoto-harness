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
    assert.match(text, /^⛩️  Escalation\n╭─+╮\n/);
    assert.match(text, /╰─+╯$/);
    assert.match(text, /Why this needs approval/);
    assert.match(text, /› Reject/);
    assert.ok(!text.includes("› Approve"));
    assert.ok(!text.includes("PgUp")); // No scroll noise for a short request.
    assert.doesNotMatch(text, /One operation|policy unchanged|Mikoto Escalation Request/);
    // All border rows have the same width even in terminals that render the
    // torii in one cell. The emoji is confined to the standalone title.
    assert.ok(lines.slice(1).every((line) => visibleWidth(line) === 104));
    assert.ok(lines.slice(1).every((line) => !line.includes("⛩")));
    assert.ok(colors.includes("customMessageLabel"));
    assert.ok(!colors.includes("accent") && !colors.includes("warning"));
    assert.ok(lines.some((line) => line.includes("\x1b[7m\x1b[1m › Reject ")));
    component.handleInput("\x1b[D");
    assert.match(stripAnsi(component.render(80).join("\n")), /› Approve/);
    component.handleInput("\x1b[C");

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
    assert.match(component.render(80).join("\n"), /Reason for the model/);
    assert.ok(component.render(80).join("\n").includes(CURSOR_MARKER));
    component.handleInput("\x1b");
    assert.equal(results.length, 0);
    assert.match(component.render(80).join("\n"), /› Reject/);
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
    assert.match(component.render(80).join("\n"), /Esc back/);
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
    assert.match(render({ version: 99 }, false), /invalid decision record/);
    const data = { version: 1, source: "test", requestId: "1", verb: "Write",
      subject: ["/a", "/b\x1b[31m"], why: "Needed", result: { decision: "approve" } };
    assert.match(render(data, false), /^Permission approved · /);
    assert.match(render(data, true), /\/b\\u\{1b\}/);
    assert.ok(!render(data, true).includes("\x1b"));
    const rejected = { ...data, result: { decision: "reject", cause: "user", reason: "Keep it private" } };
    assert.match(render(rejected, false), /Permission rejected: user/);
    assert.match(render(rejected, true), /Reason: Keep it private/);
    assert.deepEqual(new Set(colors), new Set(["muted"]));
  });
});
