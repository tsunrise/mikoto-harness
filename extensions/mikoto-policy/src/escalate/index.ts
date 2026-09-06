import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EscalationBroker } from "./broker.ts";
import { provideEscalationApi } from "./api.ts";
import { registerDecisionRenderer } from "./ui.ts";

export function installEscalation(pi: ExtensionAPI): EscalationBroker {
  const broker = new EscalationBroker(pi);
  let unsubscribe: (() => void) | undefined = provideEscalationApi(pi, broker);
  registerDecisionRenderer(pi);
  pi.on("session_start", (_event, ctx) => {
    broker.start(ctx);
    unsubscribe ??= provideEscalationApi(pi, broker);
  });
  pi.on("session_tree", (_event, ctx) => broker.start(ctx));
  pi.on("session_shutdown", () => {
    broker.invalidate();
    unsubscribe?.();
    unsubscribe = undefined;
  });
  return broker;
}
