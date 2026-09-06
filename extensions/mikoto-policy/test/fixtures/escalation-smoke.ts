// Manual/PTY smoke fixture: asks for a decision only; never executes the subject.
import { appendFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MikotoEscalationResult, MikotoEventEmitter } from "mikoto-types";

export default function smoke(pi: ExtensionAPI): void {
  pi.registerCommand("escalation-smoke", {
    description: "Test the escalation dialog without executing anything",
    async handler(_args, ctx) {
      const events: MikotoEventEmitter = pi.events;
      let claimed = false;
      const result = await new Promise<MikotoEscalationResult>((resolve) => {
        events.emit("mikoto-policy:escalate", {
          requestId: "smoke", source: "Mikoto smoke test", verb: "Test Only",
          subject: ["/test/no-operation", "/test/second-target"],
          why: "Test the real Pi UI; no operation will execute.",
          signal: new AbortController().signal,
          claim: () => { if (claimed) return false; claimed = true; return true; },
          callback: resolve,
        });
        if (!claimed) resolve({ decision: "reject", cause: "unavailable" });
      });
      const output = process.env.MIKOTO_ESCALATION_SMOKE_RESULT;
      if (output) await appendFile(output, `${JSON.stringify({ mode: ctx.mode, result })}\n`);
      if (ctx.hasUI) ctx.ui.notify(JSON.stringify(result), "info");
    },
  });
}
