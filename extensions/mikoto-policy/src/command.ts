import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PERMISSION_PATH,
  type MikotoPolicyDocumentLoader,
} from "./config.ts";

// register /mikoto-policy:view to display current policy to UI (not sent to LLM)
export function registerViewConfigCommand(
  loader: MikotoPolicyDocumentLoader,
  pi: ExtensionAPI,
) {
  pi.registerCommand("mikoto-policy:view", {
    description: "View the resolved Mikoto policy",
    handler: async (_args, ctx) => {
      const loaded = await loader.debugLoad(
        ctx.cwd,
        ctx.isProjectTrusted(),
      );
      const output = [
        `Global config: ${loaded.globalConfigPath}`,
        `Workspace config: ${loaded.workspaceConfigPath}`,
        `Policy documentation: ${PERMISSION_PATH}`,
        "",
        "Resolved policy:",
        JSON.stringify(loaded.document, null, 2),
      ];
      if (loaded.warnings.length > 0) {
        output.push(
          "",
          "Warnings:",
          ...loaded.warnings.map((warning) => `- ${warning}`),
        );
      }
      const text = output.join("\n");

      if (ctx.hasUI) {
        ctx.ui.notify(text, "info");
      } else {
        console.error(text);
      }
    },
  });
}
