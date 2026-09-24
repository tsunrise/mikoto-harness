import { clampThinkingLevel, type Api, type Context, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EscalationSettings } from "../../config.ts";

export const DEADLINE_MS = 90_000;
export const ATTEMPTS = 3;
export const ROUNDS = 8;
export const TOOL_CALLS = 32;

/** A provider may ignore abort. Detach it without letting late work resume the loop. */
export function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export function resolveReviewer(ctx: ExtensionContext, settings: EscalationSettings) {
  const agent = settings.autoReview.agent;
  const model = ctx.modelRegistry.find(agent.provider, agent.model);
  if (!model) throw new Error("missing_model");
  return {
    model,
    requested: agent.thinkingLevel,
    effective: clampThinkingLevel(model, agent.thinkingLevel),
  };
}

export function outputTokens(model: Model<Api>): number {
  return Math.min(8192, model.maxTokens);
}

export async function callModel(
  ctx: ExtensionContext,
  resolved: ReturnType<typeof resolveReviewer>,
  context: Context,
  sessionId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const stream = ctx.modelRegistry.streamSimple(resolved.model, context, {
    signal,
    sessionId,
    cacheRetention: "short",
    maxTokens: outputTokens(resolved.model),
    ...(resolved.effective === "off" ? {} : { reasoning: resolved.effective }),
  });
  const result = await abortable(stream.result(), signal);
  signal.throwIfAborted();
  if (result.stopReason !== "stop" && result.stopReason !== "toolUse") {
    throw new Error("provider_terminal");
  }
  return result;
}
