import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MikotoEventEmitter } from "mikoto-types";
import { createAuthResolver } from "./auth.ts";
import { bind, disposeSafely } from "./bind.ts";
import { search, searchModel, type Fetch } from "./client.ts";
import { errorResponse, WebError } from "./errors.ts";
import { commandsSchema } from "./schema.ts";

type Runtime = {
  lifetime: AbortController;
  operations: AbortController;
  model: string;
  active: number;
  dispose?: () => void;
};

// Options are dependency-injection seams, not user-configurable upstreams.
export function registerWeb(
  pi: ExtensionAPI,
  options: { fetch?: Fetch; timeoutMs?: number; bindTimeoutMs?: number } = {},
): void {
  const events: MikotoEventEmitter = pi.events;
  let runtime: Runtime | undefined;
  const stop = () => {
    runtime?.lifetime.abort();
    runtime?.operations.abort();
    disposeSafely(runtime?.dispose);
    runtime = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    stop();
    const current: Runtime = {
      lifetime: new AbortController(),
      operations: new AbortController(),
      model: searchModel(ctx.model),
      active: 0,
    };
    runtime = current;
    const resolveAuth = createAuthResolver(ctx.modelRegistry);
    const sessionId = ctx.sessionManager.getSessionId();
    const warn = () => {
      if (!current.lifetime.signal.aborted && ctx.hasUI) {
        ctx.ui.notify("Mikoto Web unavailable. Check Pi login and Garden, then reload.", "warning");
      }
    };
    try {
      await resolveAuth(current.lifetime.signal);
    } catch {
      warn();
      return;
    }
    if (current.lifetime.signal.aborted) return;
    const dispose = await bind(events, {
      owner: "Mikoto Web",
      method: "POST",
      path: "/web/run",
      bodySchema: commandsSchema,
      async handler({ body, signal: gardenSignal }) {
        const signal = AbortSignal.any([
          gardenSignal, current.lifetime.signal, current.operations.signal,
        ]);
        signal.throwIfAborted();
        if (current.active >= 2) return errorResponse(new WebError("rate_limited"));
        current.active++;
        const model = current.model;
        try {
          const auth = await resolveAuth(signal);
          const result = await search({ sessionId, model, commands: body, auth, signal }, options);
          return {
            status: 200,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
            body: result,
          };
        } catch (error) {
          signal.throwIfAborted();
          return errorResponse(error);
        } finally {
          current.active--;
        }
      },
    }, current.lifetime.signal, options.bindTimeoutMs);
    if (current.lifetime.signal.aborted) disposeSafely(dispose);
    else {
      current.dispose = dispose;
      if (!dispose) warn();
    }
  });

  pi.on("model_select", (event) => {
    if (runtime) runtime.model = searchModel(event.model);
  });
  pi.on("session_tree", (_event, ctx) => {
    if (!runtime) return;
    runtime.operations.abort();
    runtime.operations = new AbortController();
    runtime.model = searchModel(ctx.model);
  });
  pi.on("session_shutdown", stop);
}

export default function mikotoWeb(pi: ExtensionAPI): void {
  registerWeb(pi);
}
