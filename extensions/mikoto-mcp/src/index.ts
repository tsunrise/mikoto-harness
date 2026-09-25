import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MikotoEventEmitter } from "mikoto-types";
import { bind, disposeSafely } from "./bind.ts";
import { registerCommands } from "./commands.ts";
import { errorResponse, jsonResponse, McpError, safeName } from "./errors.ts";
import { Manager, type ManagerOptions } from "./manager.ts";
import { callSchema } from "./schema.ts";
import { registerSearchTool } from "./search-tool.ts";

// Internal test seams; production still has one fixed user configuration path.
export function registerMcp(pi: ExtensionAPI, options: ManagerOptions & { bindTimeoutMs?: number } = {}) {
  const events: MikotoEventEmitter = pi.events;
  let runtime: { manager: Manager; dispose?: () => void; binding?: Promise<void>; cleanupWarnings: string[] } | undefined;
  let generation = 0;
  let stopping = Promise.resolve();
  function stop(ctx: ExtensionContext) {
    const old = runtime;
    runtime = undefined;
    if (old) {
      old.manager.lifetime.abort();
      disposeSafely(old.dispose);
      stopping = Promise.allSettled([stopping, old.binding, old.manager.close()]).then(() => {
        // Cleanup is owned by this lifecycle handler, not a late background
        // callback using the previous session's invalid context.
        for (const reason of old.cleanupWarnings) warn(ctx, undefined, reason);
      });
    }
    return stopping;
  }
  const warn = (ctx: ExtensionContext, server: string | undefined, reason: string) => {
    const message = `Mikoto MCP${server === undefined ? "" : ` (${safeName(server)})`}: ${reason}. Check configuration and reload.`;
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else process.stderr.write(message + "\n");
  };
  registerSearchTool(pi, () => runtime?.manager);
  registerCommands(pi, () => runtime?.manager);
  pi.on("session_start", async (_event, ctx) => {
    const id = ++generation;
    await stop(ctx);
    if (id !== generation) return;
    const cleanupWarnings: string[] = [];
    const manager = new Manager(ctx.cwd, (s, r) => {
      if (r === "artifact_cleanup_failed" && manager.lifetime.signal.aborted) cleanupWarnings.push(r);
      else if (id === generation) warn(ctx, s, r);
    }, options);
    const current = { manager, cleanupWarnings } as NonNullable<typeof runtime>;
    runtime = current;
    current.binding = (async () => {
      const dispose = await bind(events, {
        owner: "Mikoto MCP", method: "POST", path: "/mcp/call", bodySchema: callSchema,
        async handler({ body, signal }) {
          const now = options.now ?? Date.now;
          const deadline = now() + (options.callMs ?? 55_000);
          try {
            const response = jsonResponse(await manager.call(body, signal));
            if (now() >= deadline) {
              const error = new McpError("call_timeout");
              error.executionCompleted = true;
              throw error;
            }
            return response;
          }
          catch (error) { return errorResponse(error, body.server, body.name); }
        },
      }, manager.lifetime.signal, options.bindTimeoutMs);
      if (manager.lifetime.signal.aborted) disposeSafely(dispose);
      else {
        current.dispose = dispose;
        manager.callRouteBound = !!dispose;
        if (!dispose) warn(ctx, undefined, "call_route_unavailable");
      }
    })();
    // Bootstrap and binding are independent. Neither awaits remote discovery.
    await current.binding;
  });
  pi.on("session_tree", () => runtime?.manager.navigate());
  pi.on("session_shutdown", async (_event, ctx) => { generation++; await stop(ctx); });
}

export default function mikotoMcp(pi: ExtensionAPI) { registerMcp(pi); }
