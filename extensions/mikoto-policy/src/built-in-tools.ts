import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
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

const ENFORCED_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
]);

export function enforcePiNativeTools(
  loader: MikotoPolicyDocumentLoader,
  pi: ExtensionAPI,
) {
  pi.on("tool_call", async (event, ctx) => {
    if (!ENFORCED_TOOL_NAMES.has(event.toolName)) return;

    const { document: effectivePolicy } = await loader.load(
      ctx.cwd,
      ctx.isProjectTrusted(),
    );

    let toolPath: string;
    if (isToolCallEventType("read", event)) {
      toolPath = event.input.path;
    } else if (isToolCallEventType("grep", event)) {
      toolPath = event.input.path ?? ".";
    } else if (isToolCallEventType("find", event)) {
      toolPath = event.input.path ?? ".";
    } else if (isToolCallEventType("ls", event)) {
      toolPath = event.input.path ?? ".";
    } else if (isToolCallEventType("write", event)) {
      toolPath = event.input.path;
    } else if (isToolCallEventType("edit", event)) {
      toolPath = event.input.path;
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

    if (!decision.allowed) return deniedToolCall();

    // Pi guarantees tool_call input mutations affect execution. Replacing the
    // lexical argument pins normal execution to the exact path policy checked.
    event.input.path = canonicalPath;
  });
}

function deniedToolCall() {
  return {
    block: true as const,
    reason:
      `Mikoto Policy denied this tool call. See ${PERMISSION_PATH}.`,
  };
}
