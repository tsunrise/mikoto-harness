import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { gardenRenderers, GardenPresentation } from "../src/ui.ts";
import type { Job } from "../src/protocol.ts";
import { builtInTheme } from "./theme.ts";
type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

test("coalesced completion notices exclude already collected jobs", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const notices: string[] = [];
  const ui = new GardenPresentation();
  ui.setContext({ hasUI: true, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext);
  const completed = (id: number) =>
    ui.completed({ id, cmd: `command-${id}`, disclosed: true } as Job);
  completed(1);
  ui.collected(1);
  t.mock.timers.tick(251);
  assert.deepEqual(notices, []);
  completed(2); completed(3);
  ui.collected(2);
  t.mock.timers.tick(251);
  assert.deepEqual(notices, ["Completed: 3 command-3"]);
  completed(4);
  ui.reset();
  t.mock.timers.tick(251);
  assert.equal(notices.length, 1);
  ui.close();
});

test("tool renderers keep terminal-control sequences inert", async () => {
  initTheme("dark", false);
  const theme = await builtInTheme("dark");
  const renderers = gardenRenderers();
  const args = { cmd: "echo safe" };
  const context: ToolRenderContext = {
    args, state: {}, executionStarted: true, argsComplete: true, isPartial: false,
    expanded: false, showImages: false, isError: false, cwd: "/", toolCallId: "test", lastComponent: undefined,
    invalidate() { assert.fail("Renderer recursively invalidated parent"); },
  };
  const call = renderers.renderCall!(args, theme, context);
  renderers.renderResult!({
    content: [{ type: "text", text: "ignored model header" }],
    details: {
      job: { id: 123, mode: "sandboxed", exit_code: 0, exit_signal: null },
      yielded: false, output: "line\n\u001b]52;c;evil\u0007tail", omitted: 0, wall_ms: 500,
      log: "/private/log", logCapped: false, capabilities: true,
    },
  }, { expanded: false, isPartial: false }, theme, context);
  const rendered = call.render(100).join("\n");
  assert.match(rendered, /line/);
  assert.match(rendered, /tail/);
  assert.doesNotMatch(rendered, /\]52|evil/);
});

test("settled tool rows reuse rendering until their content or display inputs change", async () => {
  initTheme("dark", false);
  const theme = await builtInTheme("dark");
  const renderers = gardenRenderers();
  const args = { cmd: "first command" };
  const context: ToolRenderContext = {
    args, state: {}, executionStarted: true, argsComplete: true, isPartial: false,
    expanded: false, showImages: false, isError: false, cwd: "/", toolCallId: "cache",
    lastComponent: undefined, invalidate() { assert.fail("Recursive invalidation"); },
  };
  const row = renderers.renderCall!(args, theme, context);
  const result = {
    content: [{ type: "text" as const, text: "first output\n" + "body\n".repeat(100) + "tail" }],
    details: undefined,
  };
  renderers.renderResult!(result, { expanded: false, isPartial: false }, theme, context);
  const first = row.render(100);
  assert.strictEqual(row.render(100), first, "old output must not be rewrapped on every frame");

  // Pi may reuse its args object while streaming, so identity alone is not an
  // invalidation signal. Each renderer callback must invalidate the row.
  args.cmd = "changed command";
  renderers.renderCall!(args, theme, context);
  assert.match(row.render(100).join("\n"), /changed command/);
  renderers.renderResult!(result, { expanded: true, isPartial: false }, theme, context);
  const expanded = row.render(100);
  assert.match(expanded.join("\n"), /first output/);
  assert.notStrictEqual(row.render(40), expanded, "width changes must rewrap");
  const narrow = row.render(40);
  row.invalidate();
  assert.notStrictEqual(row.render(40), narrow, "theme invalidation must rebuild styles");

  result.content[0].text = "replacement output";
  renderers.renderResult!(result, { expanded: false, isPartial: false }, theme, context);
  const replacement = row.render(40);
  assert.match(replacement.join("\n"), /replacement output/);
  assert.doesNotMatch(replacement.join("\n"), /first output/);
  assert.strictEqual(row.render(40), replacement);
});
