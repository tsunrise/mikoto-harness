import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MikotoEventPayload } from "mikoto-types";
import { EscalationBroker, reject } from "./broker.ts";

export function provideEscalationApi(pi: ExtensionAPI, broker: EscalationBroker): () => void {
  const channel = "mikoto-policy:escalate";
  return pi.events.on(channel, (data) => {
    const event = data as MikotoEventPayload<typeof channel>;
    if (!event.claim()) return;
    // The bus does not await listeners. After claiming we own completion, even
    // when admission fails before returning a promise.
    void (async () => {
      let result;
      try {
        result = await broker.request(event);
      } catch (error) {
        console.error("Mikoto Policy escalation receiver failed:", error);
        result = reject("error");
      }
      try {
        await event.callback(result);
      } catch (error) {
        console.error("Mikoto Policy escalation callback failed:", error);
      }
    })();
  });
}
