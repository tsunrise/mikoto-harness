import { isAbsolute } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const INSTRUCTION_TYPE = "mikoto-plan:instruction";
export type Mode = "plan" | "default";

export interface PlanState {
  version: 1;
  mode: Mode;
  workspaceRoot: string;
}

export type InstructionDetails = PlanState;

export type Instruction = Extract<AgentMessage, { role: "custom" }> & {
  content: string;
  details: InstructionDetails;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isState(value: unknown): value is PlanState {
  return isRecord(value) && value.version === 1
    && (value.mode === "plan" || value.mode === "default")
    && typeof value.workspaceRoot === "string" && isAbsolute(value.workspaceRoot)
    && !value.workspaceRoot.includes("\0");
}

export function isInstruction(message: AgentMessage): message is Instruction {
  if (message.role !== "custom" || message.customType !== INSTRUCTION_TYPE
    || typeof message.content !== "string") return false;
  const details: unknown = message.details;
  return isRecord(details) && isState(details);
}

export function entryMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "custom_message") {
    return {
      role: "custom", customType: entry.customType, content: entry.content,
      details: entry.details, display: entry.display,
      timestamp: Date.parse(entry.timestamp),
    };
  }
  return undefined;
}

export function inferState(branch: readonly SessionEntry[]): PlanState | undefined {
  // The full branch remains authoritative even when compaction omits an old
  // instruction from current model context.
  for (let i = branch.length - 1; i >= 0; i--) {
    const message = entryMessage(branch[i]);
    if (message && isInstruction(message)) return message.details;
  }
  return undefined;
}
