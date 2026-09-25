import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Tool, CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { MikotoGardenBindEvent } from "mikoto-types";
import type { Adapter } from "../src/client.ts";
import { registerMcp } from "../src/index.ts";
import type { ManagerOptions } from "../src/manager.ts";

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const tool = (name = "takeScreenshot", extra: Partial<Tool> = {}): Tool => ({
  name, description: "Browser screenshot", inputSchema: { type: "object", properties: { pageUrl: { type: "string", description: "Page address" } } }, ...extra,
});
export const result: CallToolResult = { content: [{ type: "text", text: "ok" }] };
export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const cleanups = new WeakMap<TestContext, (() => unknown)[]>();
export function cleanup(t: TestContext, work: () => unknown) {
  let stack = cleanups.get(t);
  if (!stack) {
    stack = [];
    cleanups.set(t, stack);
    t.after(async () => { for (const close of stack!.reverse()) await close(); });
  }
  stack.push(work);
}
export class Fake implements Adapter {
  handshake = deferred<boolean>();
  page = deferred<ListToolsResult>();
  called = deferred<void>();
  connected = deferred<void>();
  listing = deferred<void>();
  calls: { name: string; args: Record<string, unknown> }[] = [];
  listCalls = 0;
  closed = 0;
  response: (signal: AbortSignal) => Promise<CallToolResult> = async () => result;
  async connect(_signal: AbortSignal) { this.connected.resolve(); return this.handshake.promise; }
  async list() { this.listCalls++; this.listing.resolve(); return this.page.promise; }
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    this.calls.push({ name, args }); this.called.resolve(); return this.response(signal);
  }
  async close() { this.closed++; }
  ready(tools: Tool[] = [tool()]) { this.handshake.resolve(true); this.page.resolve({ tools }); return this; }
}
export async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "mcp-test-"));
  cleanup(t, () => rm(root, { recursive: true, force: true }));
  return root;
}
export async function setup(t: TestContext, servers: Record<string, unknown> = { browser: { command: "unused" } }) {
  const root = await directory(t);
  const configPath = join(root, "mcp.json"), cacheDir = join(root, "cache");
  await writeFile(configPath, JSON.stringify({ mcpServers: servers }));
  return { root, configPath, cacheDir };
}
export function harness(options: ManagerOptions & { emit?: (binding: MikotoGardenBindEvent) => void } = {}) {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const bindings: MikotoGardenBindEvent[] = [];
  const notices: { message: string; type: string }[] = [];
  let disposed = 0;
  const ctx = {
    cwd: process.cwd(), hasUI: true,
    ui: { notify: (message: string, type: string) => notices.push({ message, type }) },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: typeof commands extends Map<string, infer T> ? T : never) => commands.set(name, command),
    events: { emit(_name: string, binding: MikotoGardenBindEvent) {
      bindings.push(binding);
      if (options.emit) options.emit(binding);
      else binding.callback?.({ ok: true, bindingId: String(bindings.length), dispose() { disposed++; } });
    } },
  } as unknown as ExtensionAPI;
  registerMcp(pi, { ...options, bindTimeoutMs: 5 });
  return {
    pi, ctx, tools, commands, bindings, notices, get disposed() { return disposed; },
    start: () => handlers.get("session_start")!({}, ctx),
    stop: () => handlers.get("session_shutdown")!({}, ctx),
    tree: () => handlers.get("session_tree")!({}, ctx),
    search: async (params: unknown, signal?: AbortSignal) => tools.get("mcp_tool_search")!.execute("test", params, signal, undefined, ctx),
    command: (name: string, args = "", context = ctx) => commands.get(name)!.handler(args, context as ExtensionCommandContext),
  };
}
