import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export const SYSTEM_PROMPT_DEBUG_COMMAND = "debug-system-prompt";
export const SYSTEM_PROMPT_DEBUG_FILE = "pi-debug-systemprompt.md";

export type MikotoDevOptions = {
  readonly agentDir?: string;
};

export default function mikotoDev(
  pi: ExtensionAPI,
  options: MikotoDevOptions = {},
): void {
  pi.registerCommand(SYSTEM_PROMPT_DEBUG_COMMAND, {
    description: "Write the current system prompt to a Markdown file",
    handler: async (_args, ctx) => {
      const agentDir = options.agentDir ?? getAgentDir();
      const outputPath = path.join(agentDir, SYSTEM_PROMPT_DEBUG_FILE);

      try {
        await mkdir(agentDir, { recursive: true });
        await writeFile(outputPath, ctx.getSystemPrompt(), "utf8");
        ctx.ui.notify(`System prompt written to ${outputPath}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to write system prompt: ${message}`, "error");
      }
    },
  });
}
