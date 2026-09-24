import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EscalationBroker } from "./broker.ts";
import { provideEscalationApi } from "./api.ts";
import type { MikotoPolicyDocumentLoader } from "../config.ts";
import { registerReviewDiagnosticsCommand } from "./diagnostics-command.ts";

export function installEscalation(pi: ExtensionAPI, loader: MikotoPolicyDocumentLoader): EscalationBroker {
  const broker = new EscalationBroker(pi);
  registerReviewDiagnosticsCommand(pi, broker.reviewDiagnostics);
  let unsubscribe: (() => void) | undefined = provideEscalationApi(pi, broker);
  let generation = 0;
  const initialize = async (_event: unknown, ctx: ExtensionContext) => {
    const current = ++generation;
    broker.invalidate();
    const loaded = await loader.load(ctx.cwd, ctx.isProjectTrusted());
    if (current !== generation) return;
    broker.start(ctx, loaded);
    unsubscribe ??= provideEscalationApi(pi, broker);
  };
  pi.on("session_start", initialize);
  pi.on("session_tree", initialize);
  // The structured prompt options are exposed on this event (not on ordinary
  // ExtensionContext). Observe only: do not alter the parent's prompt/context.
  pi.on("before_agent_start", (event) => {
    broker.setContextFiles(event.systemPromptOptions.contextFiles ?? []);
  });
  pi.on("session_shutdown", () => {
    generation++;
    broker.invalidate();
    unsubscribe?.();
    unsubscribe = undefined;
  });
  return broker;
}
