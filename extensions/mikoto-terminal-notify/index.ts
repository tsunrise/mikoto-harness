import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MikotoEventEmitter } from "mikoto-types";
import { z } from "zod";

const MAX_MESSAGE_LENGTH = 16 * 1024;

function sanitize(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

export default function terminalNotify(pi: ExtensionAPI): void {
  const events: MikotoEventEmitter = pi.events;
  let disposeBinding: (() => void) | undefined;
  let tokens = 10;
  let updated = Date.now();

  pi.on("session_start", (_event, ctx) => {
    disposeBinding?.();
    disposeBinding = undefined;
    let failure: string | undefined;

    events.emit("mikoto-garden:bind", {
      owner: "Terminal Notify",
      method: "POST",
      path: "/update",
      bodyFormat: "text",
      bodySchema: z.string().max(MAX_MESSAGE_LENGTH),
      async handler({ body, signal }) {
        signal.throwIfAborted();
        const now = Date.now();
        tokens = Math.min(10, tokens + (now - updated) / 100);
        updated = now;
        if (tokens < 1) return { status: 429 };
        tokens--;
        if (!ctx.hasUI) return { status: 503, body: "UI unavailable" };
        ctx.ui.notify(sanitize(body), "info");
        return { status: 204 };
      },
      callback(result) {
        if (!result.ok) {
          failure ??= result.reason;
          return;
        }
        if (disposeBinding) {
          result.dispose();
          return;
        }
        disposeBinding = result.dispose;
      },
    });

    if (!disposeBinding && ctx.hasUI) {
      ctx.ui.notify(
        `Terminal notification capability unavailable${failure ? `: ${failure}` : ""}`,
        "warning",
      );
    }
  });

  pi.on("session_shutdown", () => {
    disposeBinding?.();
    disposeBinding = undefined;
  });
}
