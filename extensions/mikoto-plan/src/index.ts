import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { cancelledPayload, ResponsesDelivery, supportsNativeDelivery } from "./delivery.ts";
import { instructionMessage } from "./prompts.ts";
import { inferState, INSTRUCTION_TYPE, isInstruction, type InstructionDetails, type Mode, type PlanState } from "./state.ts";

export default function mikotoPlan(pi: ExtensionAPI): void {
  let desiredMode: Mode = "default";
  let workspaceRoot: string;
  let warnedMissingQuestion = false;
  let delivery: ResponsesDelivery | undefined;

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
    delivery = undefined;
  });
  pi.on("session_tree", () => {
    // Navigation changes the branch-inferred mode, not the user's selection.
    delivery = undefined;
  });
  pi.on("session_shutdown", () => {
    delivery = undefined;
    desiredMode = "default";
  });
  pi.on("model_select", () => { delivery = undefined; });
  pi.on("session_before_tree", () => { delivery = undefined; });
  pi.on("agent_end", () => { delivery = undefined; });

  pi.on("before_agent_start", (_event, ctx) => {
    const sent = inferState(ctx.sessionManager.getBranch());
    if ((sent?.mode ?? "default") === desiredMode) return;
    const state: PlanState = {
      version: 1, mode: desiredMode,
      workspaceRoot: desiredMode === "plan" ? workspaceRoot : sent?.workspaceRoot ?? workspaceRoot,
    };
    // For `/plan prompt`, the command handler called sendUserMessage() first.
    // However, Pi has only validated the prompt and built its user message in a
    // local array when before_agent_start runs; it has not appended that message
    // to the branch yet. Because the session is idle, sending without triggering
    // another turn appends this instruction now. Pi then starts the agent run and
    // appends the pending user message, giving us instruction -> user ordering.
    pi.sendMessage(instructionMessage(state), { triggerTurn: false });
  });

  pi.on("context", (event, ctx) => {
    // TODO: If more extensions need developer-role delivery, move this
    // provider-specific carrier conversion into a shared extension with a
    // narrow event-bus contract. It should promote only explicitly registered
    // and acknowledged custom message types, rather than allowing arbitrary
    // messages to claim the higher-trust developer role.
    delivery = supportsNativeDelivery(ctx.model) ? new ResponsesDelivery() : undefined;
    if (delivery) return { messages: delivery.prepare(event.messages) };
  });

  pi.on("before_provider_request", (event, ctx) => {
    const currentDelivery = delivery;
    // A carrier map belongs to exactly one context/provider handoff. Clearing
    // it here prevents unrelated requests from observing stale carrier state.
    delivery = undefined;
    if (!currentDelivery) return;
    try {
      return currentDelivery.rewrite(event.payload);
    } catch (error) {
      const reason = `Mikoto Plan: native instruction delivery failed; run aborted. ${error instanceof Error ? error.message : String(error)}`;
      ctx.abort();
      notify(ctx, reason, "error");
      return cancelledPayload(reason);
    }
  });
}
