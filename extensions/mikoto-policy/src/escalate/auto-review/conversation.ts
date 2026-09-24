import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";

/** Only a completed assessment checkpoints state; abandoned drafts have no owner. */
export class ReviewConversation {
  sessionId = randomUUID();
  messages: Message[] = [];
  prefix: string[] = [];
  identity = "";

  matches(identity: string, projection: string[]): boolean {
    return this.identity === identity && this.prefix.length <= projection.length &&
      this.prefix.every((entry, i) => entry === projection[i]);
  }

  reset(): void {
    this.sessionId = randomUUID();
    this.messages = [];
    this.prefix = [];
    this.identity = "";
  }

  commit(identity: string, projection: string[], messages: Message[], signal: AbortSignal): void {
    signal.throwIfAborted();
    this.identity = identity;
    this.prefix = projection;
    this.messages = messages;
  }
}
