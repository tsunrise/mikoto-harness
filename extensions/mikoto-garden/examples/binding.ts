import { z } from "zod";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MikotoEventEmitter } from "mikoto-types";

export default function example(pi: ExtensionAPI): void {
  const events: MikotoEventEmitter = pi.events;
  pi.on("session_start", () => {
    events.emit("mikoto-garden:bind", {
      owner: "Garden example", method: "POST", path: "/example",
      bodySchema: z.strictObject({
        message: z.string().min(1).max(1000),
        count: z.number().int().min(1).max(5).default(1),
      }),
      async handler({ body, signal }) {
        signal.throwIfAborted();
        return { status: 200, body: `${body.count}: ${body.message}` };
      },
    });
  });
}
