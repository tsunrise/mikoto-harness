import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerWeb } from "../src/index.ts";
import type { AuthRegistry } from "../src/auth.ts";
import type { Fetch } from "../src/client.ts";

export const jwt = (id = "account-canary") =>
  `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.signature`;

export function registry() {
  const configured = new Set<string>(["openai-codex", "openai"]);
  const calls: string[] = [];
  const auth: AuthRegistry = {
    getProviderAuthStatus(provider) { return { configured: configured.has(provider) }; },
    async getProviderAuth(provider) {
      calls.push(provider);
      return { auth: { apiKey: provider === "openai-codex" ? jwt() : "api-key-canary" } };
    },
    getProvider() { return undefined; },
  };
  return { auth, configured, calls };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function fixture(options: { fetch?: Fetch; timeoutMs?: number } = {}) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const auth = registry();
  const notices: unknown[] = [];
  const tools: ToolDefinition[] = [];
  const active = ["codemode", "read"];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
    registerTool(tool: ToolDefinition) { tools.push(tool); },
    getActiveTools() { return [...active]; },
    setActiveTools() { assertNever(); },
  } as unknown as ExtensionAPI;
  const ctx = {
    modelRegistry: auth.auth,
    model: { provider: "openai-codex", id: "gpt-5.4" },
    sessionManager: { getSessionId: () => "session-one" },
    hasUI: true,
    ui: { notify: (...args: unknown[]) => { notices.push(args); } },
  } as unknown as ExtensionToolContext;
  registerWeb(pi, {
    fetch: options.fetch ?? (async () => Response.json({ output: "test", results: [] })),
    timeoutMs: options.timeoutMs,
  });
  return {
    ...auth, ctx, tools, notices, active,
    async start() { await handlers.get("session_start")!({}, ctx); },
    stop() { handlers.get("session_shutdown")!({}, ctx); },
    tree() { handlers.get("session_tree")!({}, ctx); },
    model(provider: string, id: string) {
      ctx.model = { ...ctx.model, provider, id } as typeof ctx.model;
    },
    call(signal?: AbortSignal, args: unknown = { search_query: [{ q: "test" }] }) {
      return tools[0].execute("fixture", args as any, signal, undefined, ctx);
    },
  };
}

function assertNever(): never {
  throw new Error("Web must not change the active tool set");
}
