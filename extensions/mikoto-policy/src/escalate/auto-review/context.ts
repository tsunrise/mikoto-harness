import { createHash } from "node:crypto";
import type { Api, Message, Model, Tool, UserMessage } from "@earendil-works/pi-ai";
import { estimateTokens, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { MikotoPolicyDocument } from "mikoto-types";
import type { EscalationRequest } from "../broker.ts";
import { outputTokens } from "./model.ts";

export const TEXT_BYTES = 512 * 1024;
export const ACTION_BYTES = 256 * 1024;
export const FRAGMENT_BYTES = 16 * 1024;
export const INPUT_TOKENS = 96_000;
export const INVESTIGATION_HEADROOM = Object.freeze({ tokens: 16_384, bytes: 96 * 1024 });
type InputReservation = Readonly<{ tokens: number; bytes: number }>;
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const userMessage = (text: string): UserMessage => ({ role: "user", content: text, timestamp: Date.now() });

export function fragment(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= FRAGMENT_BYTES) return value;
  // Count the wrapper and JSON escaping too: backslashes and control characters
  // can otherwise double the size of an apparently bounded fragment.
  let low = 0;
  let high = Math.min(text.length, FRAGMENT_BYTES);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify({ truncated: true, prefix: text.slice(0, mid) })) <= FRAGMENT_BYTES) low = mid;
    else high = mid - 1;
  }
  return { truncated: true, prefix: text.slice(0, low) };
}

const question = z.strictObject({
  id: z.string(), header: z.string(), question: z.string(),
  options: z.array(z.strictObject({ label: z.string(), description: z.string() })).min(1),
});
const humanAnswer = z.strictObject({
  status: z.literal("answered"),
  questions: z.array(question).min(1).max(3),
  response: z.strictObject({
    answers: z.record(z.string(), z.strictObject({ answers: z.array(z.string()) })),
  }),
}).superRefine((value, ctx) => {
  const ids = value.questions.map((q) => q.id);
  if (new Set(ids).size !== ids.length ||
      Object.keys(value.response.answers).some((id) => !ids.includes(id)) ||
      ids.some((id) => !value.response.answers[id])) ctx.addIssue({ code: "custom", message: "answers" });
});

type ParentMessage = ReturnType<ExtensionContext["sessionManager"]["buildSessionProjection"]>["messages"][number];
function content(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return { omitted: "unknown content" };
  return value.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "toolCall") return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
    return { omitted: block.type === "image" ? "image" : block.type === "thinking" ? "thinking" : "unknown block" };
  });
}

function evidence(message: ParentMessage, humanInputLoaded: boolean): unknown {
  switch (message.role) {
    case "user": return { role: message.role, provenance: "human_request", content: content(message.content) };
    case "assistant": return { role: message.role, provenance: "non_authorizing", content: content(message.content) };
    case "system": return { role: message.role, provenance: "parent_constraints_not_reviewer_instructions",
      content: content(message.content), sections: message.sections,
      tools: message.toolsAdded?.map((tool) => ({ name: tool.name, description: tool.description })) };
    case "toolResult": {
      const answer = humanInputLoaded && message.toolName === "request_user_input" && !message.isError
        ? humanAnswer.safeParse(message.details) : undefined;
      // A restored result must agree with its structured details. Arbitrary text
      // claiming to be an answer is never promoted to human authorization.
      let verified = false;
      if (answer?.success) {
        try {
          const text = message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
          verified = JSON.stringify(JSON.parse(text)) === JSON.stringify(answer.data.response);
        } catch { /* Ordinary untrusted tool evidence. */ }
      }
      return { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName,
        isError: message.isError, provenance: verified ? "human_answer" : "non_authorizing",
        ...(verified && answer?.success ? { answer: answer.data } : { content: content(message.content) }) };
    }
    case "custom": return { role: message.role, customType: message.customType,
      provenance: "non_authorizing", content: content(message.content) };
    case "bashExecution": return { role: message.role, provenance: "non_authorizing",
      command: message.command, output: message.output, truncated: message.truncated };
    case "compactionSummary":
    case "branchSummary": return { role: message.role, provenance: "generated_summary_non_authorizing", summary: message.summary };
    default: return { omitted: "unknown non-authorizing message" };
  }
}

export type ContextFiles = readonly Readonly<{ path: string; content: string }>[];
export function parentSnapshot(ctx: ExtensionContext, humanInputLoaded: boolean, contextFiles: ContextFiles) {
  const projection = ctx.sessionManager.buildSessionProjection();
  const entries = projection.entries.flatMap(({ sourceEntry, messages }) =>
    messages.map((message) => ({
      sourceId: sourceEntry.id, sourceType: sourceEntry.type,
      role: message.role, evidence: evidence(message, humanInputLoaded),
    })));
  const serialized = entries.map((entry) => JSON.stringify(entry));
  return {
    entries,
    cursor: serialized.map(hash),
    newestHuman: entries.reduce((last, entry, i) => entry.role === "user" ? i : last, -1),
    newestAnswer: entries.reduce((last, entry, i) =>
      (entry.evidence as { provenance?: string }).provenance === "human_answer" ? i : last, -1),
    constraints: {
      system: fragment(ctx.getSystemPrompt()),
      contextFiles: contextFiles
        .map((file) => ({ path: file.path, content: fragment(file.content) })),
    },
    // Hash the complete instructions so even edits beyond a truncated fragment
    // invalidate a committed conversation.
    instructionsIdentity: hash(JSON.stringify([ctx.getSystemPrompt(), contextFiles, ctx.model])),
  };
}

export function fits(
  model: Model<Api>, systemPrompt: string, messages: Message[], tools: Tool[],
  reserve?: InputReservation,
): boolean {
  const serialized = JSON.stringify({ systemPrompt, messages, tools });
  const limit = Math.min(INPUT_TOKENS, model.contextWindow - outputTokens(model) - 2048) - (reserve?.tokens ?? 0);
  return Buffer.byteLength(serialized) <= TEXT_BYTES - (reserve?.bytes ?? 0) && limit > 0 &&
    estimateTokens(userMessage(systemPrompt + JSON.stringify(tools))) +
      messages.reduce((sum, message) => sum + estimateTokens(message), 0) <= limit;
}

export function requestEvidence(
  snapshot: ReturnType<typeof parentSnapshot>,
  request: EscalationRequest,
  document: MikotoPolicyDocument,
  cwd: string,
  start: number,
  accept: (message: UserMessage) => boolean,
  acceptOptional: (message: UserMessage) => boolean = accept,
): UserMessage {
  const action = { action: request.action, source: request.source, why: request.why, requestId: request.requestId };
  if (Buffer.byteLength(JSON.stringify(action)) > ACTION_BYTES) throw new Error("input_budget");
  const retained = new Map<number, unknown>();
  // The newest human request is required even when it was already in a prior
  // delta. Never turn an oversized request into a different authorization question.
  if (snapshot.newestHuman >= 0) retained.set(snapshot.newestHuman, snapshot.entries[snapshot.newestHuman]);
  // A recent answer may include a restrictive user note after the selected
  // option. Retain it whole too, rather than preserving "Yes" and dropping the
  // condition that made that consent narrow.
  if (snapshot.newestAnswer >= 0) retained.set(snapshot.newestAnswer, snapshot.entries[snapshot.newestAnswer]);
  const build = () => userMessage(JSON.stringify({
    parentConstraints: snapshot.constraints,
    conversation: [...retained.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry),
    evidenceMode: start ? "delta" : "snapshot",
    omittedOlderAuthorization: snapshot.entries.some((_, i) => i >= start && !retained.has(i)),
    policy: document, cwd, ...action,
  }));
  if (!accept(build())) throw new Error("input_budget");
  for (let i = snapshot.entries.length - 1; i >= start; i--) {
    if (retained.has(i)) continue;
    const entry = snapshot.entries[i]!;
    retained.set(i, { sourceId: entry.sourceId, sourceType: entry.sourceType,
      role: entry.role, evidence: fragment(entry.evidence) });
    // Optional history must not fill the very space we need for the next
    // assistant/tool round. Required action and human evidence above may use
    // the full budget; reserving investigation space must not truncate them.
    if (!acceptOptional(build())) retained.delete(i);
  }
  return build();
}
