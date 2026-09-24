import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isInstruction, isRecord } from "./state.ts";

/**
 * Whether the model accepts system messages mid-conversation.
 *
 * Pi sets this compat flag only for models verified to accept them (for
 * example `developer` items on OpenAI Responses, `role: "system"` on
 * Anthropic Messages). Without it, Pi folds later system messages into the
 * leading system prompt, which invalidates the cached prefix on every mode
 * switch, so those models receive the instruction as ordinary user text.
 */
export function supportsNativeDelivery(model?: Model<Api>): boolean {
  const compat: unknown = model?.compat;
  return isRecord(compat) && compat.supportsMidConvoSystemMessages === true;
}

/**
 * Request-local conversion of instruction messages into native system
 * messages. The stored session history keeps the custom messages.
 *
 * Instructions are stored after the user message that triggered them, which
 * is where Anthropic requires a mid-conversation system message. Providers
 * read a system message at index 0 as the whole system prompt, so an
 * instruction there (possible only in a hand-built history) stays user text.
 */
export function toNativeInstructions(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message, index) => index > 0 && isInstruction(message)
    ? { role: "system", content: message.content, timestamp: message.timestamp }
    : message);
}
