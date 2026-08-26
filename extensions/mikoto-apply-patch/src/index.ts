import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { preparePatch } from "./native.ts";

export default function mikotoApplyPatch(pi: ExtensionAPI): void {
  pi.registerCommand("mikoto-apply-patch:rust-test", {
    description: "Call the Mikoto Apply Patch Rust binding",
    handler: async (_args, ctx) => {
      const preparedPatch = preparePatch(ctx.cwd, "");
      ctx.ui.notify(preparedPatch.hello, "info");
    },
  });
}
