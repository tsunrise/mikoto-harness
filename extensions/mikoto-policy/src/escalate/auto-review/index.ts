import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MikotoEscalationResult } from "mikoto-types";
import type { MikotoPolicyLoadResult } from "../../config.ts";
import type { EscalationRequest } from "../broker.ts";
import { parseAssessment } from "./assessment.ts";
import { fits, hash, INVESTIGATION_HEADROOM, parentSnapshot, requestEvidence, type ContextFiles } from "./context.ts";
import { ReviewConversation } from "./conversation.ts";
import type { ReviewDiagnostics, ReviewFailure, ReviewTrace } from "./diagnostics.ts";
import { abortable, ATTEMPTS, callModel, DEADLINE_MS, resolveReviewer, ROUNDS, TOOL_CALLS } from "./model.ts";
import { reviewPolicy } from "./policy.ts";
import { InvestigationTools, investigationTools } from "./tools.ts";

export type DecisionBackend = (request: EscalationRequest, signal: AbortSignal) => Promise<MikotoEscalationResult>;

export class AutoReviewer {
  private readonly conversation = new ReviewConversation();

  private readonly ctx: ExtensionContext;
  private readonly loaded: MikotoPolicyLoadResult;
  private readonly check: () => void;
  private readonly humanInputLoaded: () => boolean;
  private readonly contextFiles: () => ContextFiles;
  private readonly diagnostics: ReviewDiagnostics | undefined;
  constructor(ctx: ExtensionContext, loaded: MikotoPolicyLoadResult, check: () => void,
    humanInputLoaded: () => boolean, contextFiles: () => ContextFiles, diagnostics?: ReviewDiagnostics) {
    this.ctx = ctx;
    this.loaded = loaded;
    this.check = check;
    this.humanInputLoaded = humanInputLoaded;
    this.contextFiles = contextFiles;
    this.diagnostics = diagnostics;
  }

  readonly review: DecisionBackend = async (request, callerSignal) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, callerSignal]);
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    const trace = this.diagnostics?.begin(request.requestId, request.action.toolName);
    try {
      const result = await abortable(this.run(request, signal, trace), signal);
      trace?.finish();
      return result;
    } catch (error) {
      // Never log provider prose, model output, custom policy or investigation
      // contents. Errors are categories, not a second conversation channel.
      const known: ReviewFailure[] = ["missing_model", "input_budget", "tool_arguments", "tool_budget", "round_budget",
        "assessment_attempts", "provider_terminal"];
      const category = callerSignal.aborted ? "cancelled" : controller.signal.aborted ? "deadline" :
        known.find((category) => error instanceof Error && error.message === category) ?? "provider_or_review_failure";
      trace?.finish(category);
      console.error(`Mikoto Policy auto-review: ${category}`);
      return { decision: "reject", cause: callerSignal.aborted ? "cancelled" : "error" };
    } finally {
      clearTimeout(timer);
      // Late provider or filesystem work cannot commit or start another tool.
      controller.abort();
    }
  };

  private async run(request: EscalationRequest, signal: AbortSignal, trace?: ReviewTrace): Promise<MikotoEscalationResult> {
    const check = () => { signal.throwIfAborted(); this.check(); };
    check();
    if (this.loaded.diagnostics.some((d) =>
      ["invalid_layer", "unreadable_layer", "canonical_rule"].includes(d.kind))) {
      console.error("Mikoto Policy auto-review: policy_diagnostics");
      trace?.finish("policy_diagnostics");
      return { decision: "reject", cause: "error" };
    }
    const resolved = resolveReviewer(this.ctx, this.loaded.settings);
    const systemPrompt = reviewPolicy(this.loaded.settings.autoReview.policy);
    const snapshot = parentSnapshot(this.ctx, this.humanInputLoaded(), this.contextFiles());
    const identity = hash(JSON.stringify([
      snapshot.instructionsIdentity, resolved, this.loaded.settings, this.loaded.document, this.ctx.cwd,
    ]));
    const conversation = this.conversation;
    if (!conversation.matches(identity, snapshot.cursor)) conversation.reset();
    const makeRequest = () => requestEvidence(snapshot, request, this.loaded.document, this.ctx.cwd,
      conversation.prefix.length,
      (message) => fits(resolved.model, systemPrompt, [...conversation.messages, message], investigationTools),
      (message) => fits(resolved.model, systemPrompt, [...conversation.messages, message], investigationTools,
        INVESTIGATION_HEADROOM));
    let evidence;
    try {
      evidence = makeRequest();
      // A valid prior review may fit alone but leave the next request unable
      // to investigate. Rebuild from the bounded parent snapshot before using
      // that committed history as the next model-call prefix.
      if (conversation.messages.length && !fits(resolved.model, systemPrompt,
        [...conversation.messages, evidence], investigationTools, INVESTIGATION_HEADROOM)) {
        conversation.reset();
        evidence = makeRequest();
      }
    }
    catch {
      conversation.reset();
      evidence = makeRequest();
    }
    const base = [...conversation.messages, evidence];
    const tools = new InvestigationTools(this.ctx.cwd, this.loaded.document, check);
    let toolCalls = 0;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const messages: Message[] = [...base];
      let invalidFinal = false;
      for (let round = 0; round < ROUNDS; round++) {
        check();
        if (!fits(resolved.model, systemPrompt, messages, investigationTools)) throw new Error("input_budget");
        trace?.modelCall();
        const response = await callModel(this.ctx, resolved,
          { systemPrompt, messages, tools: investigationTools }, conversation.sessionId, signal);
        check();
        messages.push(response);
        const calls = response.content.filter((block) => block.type === "toolCall");
        if (calls.length) {
          if (response.stopReason !== "toolUse") throw new Error("provider_terminal");
          for (const call of calls) {
            check();
            if (++toolCalls > TOOL_CALLS) throw new Error("tool_budget");
            const inspected = trace?.investigation(call.name, call.arguments);
            let result: unknown;
            try {
              result = await abortable(tools.dispatch(call.name, call.arguments, signal), signal);
              check();
              inspected?.(result);
            } catch (error) {
              inspected?.(undefined, signal.aborted ? "cancelled" : "failed");
              throw error;
            }
            messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name,
              content: [{ type: "text", text: JSON.stringify(result) }], isError: false, timestamp: Date.now() });
          }
          continue;
        }
        if (response.stopReason !== "stop") throw new Error("provider_terminal");
        let assessment;
        try {
          assessment = parseAssessment(response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"));
        } catch {
          // Retry only protocol-invalid finals, and never include the failed
          // draft in the next attempt's committed evidence.
          invalidFinal = true;
          break;
        }
        check();
        conversation.commit(identity, snapshot.cursor, messages, signal);
        return assessment.outcome === "allow"
          ? { decision: "approve" }
          : { decision: "reject", cause: "user", reason: assessment.rationale };
      }
      if (!invalidFinal) throw new Error("round_budget");
    }
    throw new Error("assessment_attempts");
  }
}
