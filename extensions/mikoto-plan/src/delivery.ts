import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isInstruction, isRecord } from "./state.ts";

export function supportsNativeDelivery(model?: Model<Api>): boolean {
  return !!model && (model.api === "openai-codex-responses" || model.api === "openai-responses")
    && (!model.compat || !("supportsDeveloperRole" in model.compat)
      || model.compat.supportsDeveloperRole !== false);
}

/** One instance per context copy; never shared with session storage. */
export class ResponsesDelivery {
  private readonly carriers = new Map<string, string>();
  private readonly rewritten = new WeakSet<object>();

  prepare(messages: readonly AgentMessage[]): AgentMessage[] {
    return messages.map((message) => {
      if (!isInstruction(message)) return message;
      const token = `mikoto-plan-carrier:${randomUUID()}`;
      this.carriers.set(token, message.content);
      return { ...message, content: token };
    });
  }

  // Convert target messages to `developer` role
  rewrite(payload: unknown): unknown {
    if (this.carriers.size === 0) return payload;
    if (isRecord(payload) && this.rewritten.has(payload)) return payload;
    if (!isRecord(payload) || !Array.isArray(payload.input)) {
      throw new Error("Responses payload has no input array");
    }
    const seen = new Set<string>();
    const input = payload.input.map((item: unknown) => {
      if (!isRecord(item) || item.role !== "user"
        || (item.type !== undefined && item.type !== "message")
        || !Array.isArray(item.content) || item.content.length !== 1) return item;
      const block: unknown = item.content[0];
      if (!isRecord(block) || block.type !== "input_text" || typeof block.text !== "string") return item;
      const body = this.carriers.get(block.text);
      if (body === undefined) return item;
      if (seen.has(block.text)) throw new Error("Duplicate instruction carrier");
      seen.add(block.text);
      return { role: "developer", content: [{ type: "input_text", text: body }] };
    });
    if (seen.size !== this.carriers.size) throw new Error("Instruction carrier missing or not a standalone user item");
    const result = { ...payload, input };
    const serialized = JSON.stringify(result);
    for (const token of this.carriers.keys()) {
      if (serialized.includes(token)) throw new Error("Instruction carrier leaked into an unrelated payload field");
    }
    this.rewritten.add(result);
    return result;
  }
}

export function cancelledPayload(reason: string): object {
  // Pi catches hook exceptions. Also, 0.85.1's Codex WebSocket path can start
  // connecting before it checks the aborted signal. Both Responses adapters
  // serialize outside the hook, so this guard stops that path before transport.
  // It is used only after ctx.abort(), never on an ordinary request.
  return { toJSON() { throw new Error(reason); } };
}
