import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import type { MikotoEscalationResult } from "mikoto-types";
import { visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { EscalationComponent, inertText } from "../src/escalate/ui.ts";
import { keys, theme, tui } from "./escalation-fixtures.ts";

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
    const component = new EscalationComponent("synthetic_tool", { ...tui, terminal } as typeof tui, styledTheme, keys(), () => {});
    component.focused = true;
    const lines = component.render(160);
    const text = lines.map(stripAnsi).join("\n");
    assert.match(text, /\n╭─+╮\n/);
    assert.match(text, /╰─+╯$/);
    assert.ok(text.includes("synthetic_tool"));
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
    const component = new EscalationComponent("synthetic_tool", tui, theme,
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

    const printable = new EscalationComponent("synthetic_tool", tui, theme,
      keys({ "tui.select.confirm": ["y"] }), (result) => results.push(result));
    printable.handleInput("\x1b[D");
    printable.handleInput("y");
    assert.equal(results.length, 1);
  });

  it("returns from the reason view without deciding, preserving draft, selection and focus", () => {
    const results: MikotoEscalationResult[] = [];
    const component = new EscalationComponent("synthetic_tool", tui, theme, keys({ "tui.select.cancel": ["ctrl+x"] }), (result) => results.push(result));
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

  it("escapes tool names, truncates long names, and ignores scope navigation", () => {
    const component = new EscalationComponent("odd\x1b]52;c;secret\x07\u202e", tui, theme, keys(), () => {});
    const before = component.render(80);
    assert.ok(before.join("\n").includes("\\u{1b}]52"));
    assert.doesNotMatch(before.join("\n"), /[\x1b\x07\u202e]/);
    component.handleInput("\x1b[6~");
    assert.deepEqual(component.render(80), before);
    const long = new EscalationComponent("wide界".repeat(200), tui, theme, keys(), () => {});
    for (const width of [1, 2, 4, 12, 80]) {
      assert.ok(long.render(width).every((line) => visibleWidth(line) <= width));
    }
    assert.equal(inertText("\r\n\t"), "\\u{d}\\u{a}\\u{9}");
  });
});
