import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MikotoGardenBindEvent } from "mikoto-types";
import { registerWeb } from "../src/index.ts";
import type { AuthRegistry } from "../src/auth.ts";
import type { Commands } from "../src/schema.ts";
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

export function fixture(options: {
  fetch?: Fetch;
  emit?: (event: MikotoGardenBindEvent<Commands>) => void;
  timeoutMs?: number;
} = {}) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const auth = registry();
  const notices: unknown[] = [];
  const bindings: MikotoGardenBindEvent<Commands>[] = [];
  const disposed: number[] = [];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
    events: {
      emit(_name: string, value: unknown) {
        const event = value as MikotoGardenBindEvent<Commands>;
        const index = bindings.push(event);
        if (options.emit) options.emit(event);
        else event.callback?.({ ok: true, bindingId: `binding-${index}`, dispose: () => { disposed.push(index); } });
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    modelRegistry: auth.auth,
    model: { provider: "openai-codex", id: "gpt-5.4" },
    sessionManager: { getSessionId: () => "session-one" },
    hasUI: true,
    ui: { notify: (...args: unknown[]) => { notices.push(args); } },
  } as unknown as ExtensionContext;
  registerWeb(pi, {
    fetch: options.fetch ?? (async () => Response.json({ output: "test", results: [] })),
    timeoutMs: options.timeoutMs,
    bindTimeoutMs: 10,
  });
  return {
    ...auth, ctx, bindings, notices, disposed,
    async start() { await handlers.get("session_start")!({}, ctx); },
    stop() { handlers.get("session_shutdown")!({}, ctx); },
    tree() { handlers.get("session_tree")!({}, ctx); },
    model(provider: string, id: string) { handlers.get("model_select")!({ model: { provider, id } }, ctx); },
  };
}

export function call(
  binding: MikotoGardenBindEvent<Commands>,
  signal = new AbortController().signal,
) {
  return binding.handler({
    method: "POST", path: "/web/run", headers: {},
    body: { search_query: [{ q: "test" }], response_length: "medium" },
    signal,
  });
}
