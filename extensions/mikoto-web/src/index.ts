import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAuthResolver } from "./auth.ts";
import { search, searchModel, type Fetch } from "./client.ts";
import { WebError } from "./errors.ts";
import { formatResult, outputSchema } from "./output.ts";
import { commandsSchema, parameters } from "./schema.ts";
import { WEB_HINT, WEB_INSTRUCTIONS } from "./instructions.ts";

type Runtime = {
  lifetime: AbortController;
  operations: AbortController;
  resolveAuth: ReturnType<typeof createAuthResolver>;
  sessionId: string;
  active: number;
};

// Options are dependency-injection seams, not user-configurable upstreams.
export function registerWeb(
  pi: ExtensionAPI,
  options: { fetch?: Fetch; timeoutMs?: number } = {},
): void {
  let runtime: Runtime | undefined;
  const stop = () => {
    runtime?.lifetime.abort();
    runtime?.operations.abort();
    runtime = undefined;
  };

  // Register once, before the first prompt, even without credentials. Neither
  // login nor the first web request should change the model's tool loadout.
  pi.registerTool({
    name: "web_run",
    label: "Mikoto Web",
    exposure: "deferred",
    namespace: {
      name: "web",
      description: "Search the public web, open pages, follow links, and find text.",
      instructions: WEB_INSTRUCTIONS,
    },
    description: `Search the public web, open pages, follow numbered links, and find text.
Read describeNamespace("web") before first use. Supply 1–16 operations total.
Returns source text with reference IDs, line numbers, links and word limits,
plus supplemental results metadata. References must come from completed calls.`,
    parameters,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async execute(_id, raw, callerSignal, _update, ctx) {
      // Pi validates the public schema; Zod also enforces cross-field bounds
      // and normalization after tool_call hooks have had a chance to edit it.
      const parsed = commandsSchema.safeParse(raw);
      if (!parsed.success || Buffer.byteLength(JSON.stringify(raw)) > 16 * 1024) {
        throw new Error("Invalid web commands: supply 1–16 supported operations in at most 16 KiB.");
      }
      const current = runtime;
      if (!current) throw new Error("Web session is not initialized.");
      const signal = AbortSignal.any([
        current.lifetime.signal, current.operations.signal,
        ...(callerSignal ? [callerSignal] : []),
      ]);
      signal.throwIfAborted();
      if (current.active >= 2) throw new WebError("rate_limited");
      current.active++;
      try {
        const auth = await current.resolveAuth(signal);
        const result = await search({
          sessionId: current.sessionId,
          model: searchModel(ctx.model),
          commands: parsed.data,
          auth,
          signal,
        }, options);
        signal.throwIfAborted();
        return await formatResult(result, signal);
      } catch (error) {
        signal.throwIfAborted();
        // Transport/provider exceptions can contain credentials or URLs with
        // private query strings. Only our fixed diagnostics cross the boundary.
        throw error instanceof WebError ? error : new WebError("upstream_error");
      } finally {
        current.active--;
      }
    },
  });
  pi.on("session_start", (_event, ctx) => {
    stop();
    runtime = {
      lifetime: new AbortController(),
      operations: new AbortController(),
      resolveAuth: createAuthResolver(ctx.modelRegistry),
      sessionId: ctx.sessionManager.getSessionId(),
      active: 0,
    };
    // Auth resolves lazily, so non-web sessions do no credential refresh or
    // network work. Configuration owns codemode activation, not this extension.
    if (!pi.getActiveTools().includes("codemode") && ctx.hasUI) {
      ctx.ui.notify('Mikoto Web needs codemode. Add "+codemode" to Pi defaultTools and reload.', "warning");
    }
  });
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.web = WEB_HINT;
  });
  pi.on("session_tree", () => {
    if (!runtime) return;
    runtime.operations.abort();
    runtime.operations = new AbortController();
  });
  pi.on("session_shutdown", stop);
}

export default function mikotoWeb(pi: ExtensionAPI): void {
  registerWeb(pi);
}
