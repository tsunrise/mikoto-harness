import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { MikotoEscalationResult } from "mikoto-types";
import { isDeepStrictEqual } from "node:util";
import {
  PERMISSION_PATH,
  type MikotoPolicyDocumentLoader,
} from "./config.ts";
import {
  evaluateRead,
  evaluateWrite,
} from "./evaluate.ts";
import { getCanonicalPath } from "./canonical-path.ts";
import { resolveToolPath } from "./utils.ts";
import type { EscalationBroker } from "./escalate/broker.ts";

const ENFORCED_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
]);
const ESCALATABLE_TOOL_NAMES = new Set(["read", "write", "edit"]);

export function enforcePiBuiltInTools(
  loader: MikotoPolicyDocumentLoader,
  broker: EscalationBroker,
  pi: ExtensionAPI,
) {
  pi.on("tool_call", async (event, ctx) => {
    if (!ENFORCED_TOOL_NAMES.has(event.toolName)) return;
    if (!ownsBuiltInTool(pi, event.toolName)) {
      return {
        block: true,
        reason: `Mikoto Policy cannot enforce conflicting ${event.toolName} ownership; access denied. See ${PERMISSION_PATH}.`,
      };
    }

    const assertCurrent = broker.lifetime();
    const originalInput = structuredClone(event.input) as Record<string, unknown> & { path?: string };
    const signal = ctx.signal ?? new AbortController().signal;
    const { document: effectivePolicy } = await loader.load(
      ctx.cwd,
      ctx.isProjectTrusted(),
    );

    let toolPath: string;
    if (isToolCallEventType("read", event)) {
      toolPath = originalInput.path!;
    } else if (isToolCallEventType("grep", event)) {
      toolPath = originalInput.path ?? ".";
    } else if (isToolCallEventType("find", event)) {
      toolPath = originalInput.path ?? ".";
    } else if (isToolCallEventType("ls", event)) {
      toolPath = originalInput.path ?? ".";
    } else if (isToolCallEventType("write", event)) {
      toolPath = originalInput.path!;
    } else if (isToolCallEventType("edit", event)) {
      toolPath = originalInput.path!;
    } else {
      return;
    }

    let canonicalPath: string;
    try {
      const lexicalPath = resolveToolPath(toolPath, ctx.cwd);
      canonicalPath = getCanonicalPath(lexicalPath);
    } catch {
      return deniedToolCall();
    }

    let decision: ReturnType<typeof evaluateRead>;

    if (isToolCallEventType("read", event)) {
      decision = evaluateRead(
        effectivePolicy,
        canonicalPath,
        "file",
      );
    } else if (isToolCallEventType("grep", event)) {
      decision = evaluateRead(
        effectivePolicy,
        canonicalPath,
        "directory",
      );
    } else if (isToolCallEventType("find", event)) {
      decision = evaluateRead(
        effectivePolicy,
        canonicalPath,
        "directory",
      );
    } else if (isToolCallEventType("ls", event)) {
      decision = evaluateRead(
        effectivePolicy,
        canonicalPath,
        "directory",
      );
    } else if (isToolCallEventType("write", event)) {
      decision = evaluateWrite(
        effectivePolicy,
        canonicalPath,
      );
    } else if (isToolCallEventType("edit", event)) {
      const readDecision = evaluateRead(
        effectivePolicy,
        canonicalPath,
        "file",
      );
      decision = readDecision.allowed
        ? evaluateWrite(effectivePolicy, canonicalPath)
        : readDecision;
    } else {
      return;
    }

    if (!decision.allowed && !ESCALATABLE_TOOL_NAMES.has(event.toolName)) {
      return deniedToolCall();
    }

    if (!decision.allowed) {
      const result = await broker.request({
        requestId: event.toolCallId,
        source: "Mikoto Policy",
        action: {
          toolName: event.toolName,
          input: { ...originalInput, path: canonicalPath },
          context: { cwd: ctx.cwd, access: decision },
        },
        why: "This operation requires filesystem access denied by the current policy.",
        signal,
      });
      if (result.decision !== "approve") return deniedToolCall(result);
      if (signal.aborted) {
        return deniedToolCall({ decision: "reject", cause: "cancelled" });
      }
      try {
        if (getCanonicalPath(canonicalPath) !== canonicalPath) {
          return changedTargetToolCall();
        }
      } catch {
        return changedTargetToolCall();
      }
    }

    try {
      assertCurrent();
      signal.throwIfAborted();
      if (!isDeepStrictEqual(event.input, originalInput) ||
          getCanonicalPath(resolveToolPath(toolPath, ctx.cwd)) !== canonicalPath ||
          getCanonicalPath(canonicalPath) !== canonicalPath ||
          !ownsBuiltInTool(pi, event.toolName)) return changedTargetToolCall();
    } catch {
      return changedTargetToolCall();
    }
    // Pi guarantees tool_call input mutations affect execution. Replacing the
    // lexical argument pins normal execution to the exact path policy checked.
    event.input.path = canonicalPath;
  });
}

function ownsBuiltInTool(pi: ExtensionAPI, name: string): boolean {
  return pi.getAllTools().find((tool) => tool.name === name)
    ?.sourceInfo.source === "builtin";
}

function deniedToolCall(
  result?: Extract<MikotoEscalationResult, { decision: "reject" }>,
) {
  return {
    block: true as const,
    reason: result
      ? `Mikoto Policy denied this tool call; escalation rejected${result.cause === "user" ? "" : ` (${result.cause})`}${result.reason ? `: ${result.reason}` : "."} See ${PERMISSION_PATH}.`
      : `Mikoto Policy denied this tool call. See ${PERMISSION_PATH}.`,
  };
}

function changedTargetToolCall() {
  return {
    block: true as const,
    reason:
      `Mikoto Policy target changed during authorization; access denied. See ${PERMISSION_PATH}.`,
  };
}
