import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { supportsNativeDelivery, toNativeInstructions } from "./delivery.ts";
import { instructionMessage } from "./prompts.ts";
import { inferState, INSTRUCTION_TYPE, isInstruction, type InstructionDetails, type Mode, type PlanState } from "./state.ts";

export default function mikotoPlan(pi: ExtensionAPI): void {
  let desiredMode: Mode = "default";
  let workspaceRoot: string;
  let warnedMissingQuestion = false;

  function notify(ctx: ExtensionContext, text: string, level: "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else console.error(text);
  }

  function notifyMode(ctx: ExtensionContext, mode: Mode, sentMode: Mode): void {
    if (!ctx.hasUI) return;
    const name = mode === "plan" ? "Plan" : "Default";
    const text = sentMode === mode
      ? `Already in ${name} mode`
      : `Switch to ${name} mode at next prompt`;
    ctx.ui.notify(text, "info");
  }

  function warnQuestion(ctx: ExtensionContext): void {
    if (!warnedMissingQuestion && !pi.getActiveTools().includes("request_user_input")) {
      warnedMissingQuestion = true;
      notify(ctx, "Mikoto Plan: request_user_input is not active. Load Mikoto Question for material planning questions.", "warning");
    }
  }

  pi.registerMessageRenderer<InstructionDetails>(INSTRUCTION_TYPE, (message) => {
    if (!isInstruction(message)) return undefined;
    const text = message.details.mode === "plan" ? "Enter Plan Mode" : "Exit Plan Mode";
    // Use terminal blue explicitly, not the theme's possibly non-blue accent.
    return new Text(`\x1b[34m${text}\x1b[39m`, 1, 0);
  });

  for (const [command, mode] of [["plan", "plan"], ["lgtm", "default"]] as const) {
    pi.registerCommand(command, {
      description: mode === "plan"
        ? "Enter Plan Mode"
        : "Exit Plan Mode",
      handler: async (args, ctx) => {
        if (!ctx.isIdle()) {
          notify(ctx, "Can only switch mode when a turn completes", "warning");
          return;
        }
        const hasPrompt = args.trim().length > 0;
        const sentMode = inferState(ctx.sessionManager.getBranch())?.mode ?? "default";
        if (desiredMode !== mode && mode === "plan") workspaceRoot = resolve(ctx.cwd);
        desiredMode = mode;
        if (!hasPrompt) notifyMode(ctx, mode, sentMode);
        if (mode === "plan") warnQuestion(ctx);
        if (hasPrompt) pi.sendUserMessage(args, { expandPromptTemplates: false });
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    desiredMode = "default";
    workspaceRoot = resolve(ctx.cwd);
  });
  pi.on("session_shutdown", () => {
    desiredMode = "default";
  });

  pi.on("before_agent_start", (_event, ctx) => {
    const sent = inferState(ctx.sessionManager.getBranch());
    if ((sent?.mode ?? "default") === desiredMode) return;
    const state: PlanState = {
      version: 1, mode: desiredMode,
      workspaceRoot: desiredMode === "plan" ? workspaceRoot : sent?.workspaceRoot ?? workspaceRoot,
    };
    // Pi persists this message right after the triggering user message, so the
    // session tree shows the same user -> instruction order that providers get.
    const { customType, content, display, details } = instructionMessage(state);
    return { message: { customType, content, display, details } };
  });

  // `context_with_system` runs after every `context` handler, so other
  // extensions still see the instruction as a custom message. Only this
  // extension's typed instruction messages are converted; arbitrary messages
  // cannot claim the higher-trust system role.
  pi.on("context_with_system", (event, ctx) => {
    if (!supportsNativeDelivery(ctx.model) || !event.messages.some(isInstruction)) return;
    return { messages: toNativeInstructions(event.messages) };
  });
}
