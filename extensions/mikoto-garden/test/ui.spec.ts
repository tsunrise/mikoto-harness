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
