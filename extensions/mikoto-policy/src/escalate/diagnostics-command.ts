import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReviewDiagnostics } from "./auto-review/diagnostics.ts";

export function registerReviewDiagnosticsCommand(pi: ExtensionAPI, diagnostics: ReviewDiagnostics): void {
  pi.registerCommand("mikoto-policy:review-debug", {
    description: "Mikoto reviewer investigation diagnostics (on/off/show; memory-only)",
    handler: async (args, ctx) => {
      // Do not turn debug metadata into print/JSON output or parent messages.
      // Capture starts with the next review; on/off both discard the old trace.
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      const action = args.trim() || "show";
      if (action === "on" || action === "off") {
        diagnostics.setEnabled(action === "on");
        ctx.ui.notify(`Mikoto review diagnostics ${action}; previous trace cleared.`, "info");
      } else if (action === "show") {
        ctx.ui.notify(JSON.stringify(diagnostics.snapshot(), null, 2), "info");
      } else {
        ctx.ui.notify("Usage: /mikoto-policy:review-debug on|off|show", "warning");
      }
    },
  });
}
