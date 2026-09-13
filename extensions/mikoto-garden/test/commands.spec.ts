import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId, type Component } from "@earendil-works/pi-tui";
import { GardenPresentation, registerGardenCommands } from "../src/ui.ts";
import type { ToolRuntime } from "../src/tools.ts";
import type { Endpoint } from "../src/capability-server.ts";
import type { Job } from "../src/protocol.ts";
import { builtInTheme } from "./theme.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type ViewFactory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
const bindings: Record<string, KeyId> = {
  "tui.select.cancel": "escape", "tui.select.confirm": "enter", "tui.select.up": "up",
  "tui.select.down": "down", "tui.select.pageUp": "pageUp", "tui.select.pageDown": "pageDown",
};
async function fixture(interact?: (component: Component) => Promise<void>) {
  const commands = new Map<string, Command>();
  const notices: string[] = [];
  const frames: string[] = [];
  const requests: { method: string; data: unknown }[] = [];
  const job: Job = {
    id: 123, mode: "sandboxed", state: "running", cmd: "printf preview",
    cwd: "/test", started: Date.now(), stdinOpen: true, exit_code: null, exit_signal: null,
    disclosed: true, collected: false, unread: 7,
  };
  const client = {
    available: true,
    async request(method: string, data: unknown) {
      requests.push({ method, data });
      return { jobs: [job], tail: "preview" };
    },
  };
  let active: ToolRuntime | undefined = {
    generation: "test-generation", lifetime: new AbortController(),
    client: client as unknown as ToolRuntime["client"],
    endpoint: () => address, approvals: new Map([[123, new Set([new AbortController()])]]),
  };
  let address: Endpoint | undefined = { url: "http://127.0.0.1:12345", port: 12345, token: "debug-only-fake-token" };
  let closes = 0;
  let readiness = "ready; capabilities available";
  initTheme("dark", false);
  const theme = await builtInTheme("dark");
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/test",
    sessionManager: { getSessionId: () => "pi-test-session" },
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus() {},
      async custom(factory: ViewFactory) {
        const component = await factory(
          { terminal: { rows: 30 }, requestRender() {} } as Parameters<ViewFactory>[0],
          theme,
          { matches: (data: string, action: string) => matchesKey(data, bindings[action]), getKeys: (action: string) => [bindings[action]] } as Parameters<ViewFactory>[2],
          () => { closes++; },
        );
        if (interact) { await interact(component); return; }
        frames.push(component.render(100).join("\n"));
        component.handleInput?.("\x1b[6~");
        frames.push(component.render(100).join("\n"));
        component.handleInput?.("\x1b[5~");
        component.handleInput?.("\x1b");
      },
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    sendMessage() { assert.fail("Debug credentials must not enter model context"); },
    appendEntry() { assert.fail("Debug credentials must not be persisted"); },
  } as unknown as ExtensionAPI;
  const ui = new GardenPresentation();
  registerGardenCommands(pi, () => active, () => readiness, ui, () => address);
  return {
    commands, notices, frames, requests, client, ui, ctx,
    run: (name: string, args = "") => commands.get(name)!.handler(args, ctx),
    setRuntime: (value: ToolRuntime | undefined) => { active = value; },
    setEndpoint: (value: Endpoint | undefined) => { address = value; },
    setStatus: (value: string) => { readiness = value; },
    closes: () => closes,
  };
}
test("/ps is on-demand, non-consuming and token-hidden; debug is a separate credential-bearing view", async () => {
  const h = await fixture();
  h.ctx.mode = "rpc";
  await h.run("ps");
  await h.run("ps", "123");
  assert.ok(h.notices[0].includes("ready; capabilities available"));
  assert.match(h.notices[0], /123/);
  assert.match(h.notices[1], /preview/);
  assert.doesNotMatch(h.notices.join("\n"), /debug-only-fake-token/);
  h.ctx.mode = "tui";
  await h.run("ps:debug", "123");
  assert.match(h.frames.join("\n"), /debug-only-fake-token/);
  assert.match(h.frames.join("\n"), /test-generation/);
  assert.equal(h.notices.length, 2);
  assert.equal(h.closes(), 1);
  assert.deepEqual(h.requests, [
    { method: "list", data: {} },
    { method: "list", data: { id: 123 } },
    { method: "list", data: { id: 123 } },
  ]);
  h.client.request = async () => ({ jobs: [], tail: "" });
  h.ctx.mode = "rpc";
  await h.run("ps");
  assert.equal(h.notices.length, 3);
  assert.doesNotMatch(h.notices.at(-1)!, /123|printf preview|debug-only-fake-token/);
  h.ui.close();
});
test("/ps and debug still diagnose absent/dead executors and absent capabilities", async () => {
  const h = await fixture();
  h.ctx.mode = "rpc";
  h.client.available = false;
  h.setStatus("executor disconnected; /reload required; capabilities available");
  await h.run("ps");
  assert.match(h.notices.at(-1)!, /executor disconnected/);
  assert.equal(h.requests.length, 0);
  h.setRuntime(undefined);
  h.ctx.mode = "tui";
  await h.run("ps:debug");
  assert.match(h.frames.join("\n"), /debug-only-fake-token/);
  h.setEndpoint(undefined);
  h.frames.length = 0;
  await h.run("ps:debug");
  assert.doesNotMatch(h.frames.join("\n"), /debug-only-fake-token/);
});
test("debug rejects non-TUI invocation and stale generations without exposing credentials", async () => {
  const h = await fixture();
  for (const mode of ["rpc", "print", "json"] as const) {
    h.ctx.mode = mode;
    await h.run("ps:debug");
  }
  assert.equal(h.frames.length, 0);
  assert.equal(h.requests.length, 0);
  assert.doesNotMatch(h.notices.join("\n"), /debug-only-fake-token/);
  h.ctx.mode = "tui";
  await assert.rejects(h.run("ps:debug", "0"));
  await assert.rejects(h.run("ps", "123 extra"));
  assert.equal(h.requests.length, 0);
  const request = h.client.request;
  h.client.request = async () => { throw new Error("Unexpected detail: debug-only-fake-token"); };
  h.ctx.mode = "rpc";
  await h.run("ps", "123");
  assert.doesNotMatch(h.notices.join("\n"), /debug-only-fake-token/);
  h.client.request = async (...args) => {
    const result = await request(...args);
    h.setRuntime(undefined);
    return result;
  };
  h.ctx.mode = "tui";
  await assert.rejects(h.run("ps:debug"));
  assert.equal(h.frames.length, 0);
});
test("/ps opens a transient picker without credentials, notifications, or model messages", async () => {
  const h = await fixture();
  await h.run("ps");
  assert.match(h.frames.join("\n"), /123/);
  assert.doesNotMatch(h.frames.join("\n"), /debug-only-fake-token|GARDEN_TOKEN/);
  assert.equal(h.notices.length, 0);
  assert.deepEqual(h.requests, [{ method: "list", data: {} }]);
});
test("/ps armed stop is rejected if the generation rotates before confirmation", async () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const h = await fixture(async (component) => {
    component.handleInput?.("d");
    await tick();
    assert.deepEqual(h.requests.at(-1), { method: "list", data: { id: 123 } });
    h.setRuntime(undefined);
    component.handleInput?.("\r");
    await tick();
    component.handleInput?.("\x1b");
    await tick();
    component.handleInput?.("\x1b");
  });
  await h.run("ps");
  assert.ok(h.requests.every((request) => request.method === "list"));
});
