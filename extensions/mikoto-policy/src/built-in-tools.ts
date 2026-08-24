import { fileURLToPath } from "node:url";
import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { MikotoPolicyDocumentLoader } from "./config.ts";
import {
  evaluateRead,
  evaluateWrite,
} from "./evaluate.ts";
import { resolveToolPath } from "./utils.ts";

const PERMISSION_PATH = fileURLToPath(
  new URL("../PERMISSION.md", import.meta.url),
);

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
  const reportedWarnings = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    if (!ENFORCED_TOOL_NAMES.has(event.toolName)) return;

    const { document: effectivePolicy, warnings } = await loader.load(
      ctx.cwd,
      ctx.isProjectTrusted(),
    );
    for (const warning of warnings) {
      if (reportedWarnings.has(warning)) continue;
      reportedWarnings.add(warning);
      if (ctx.hasUI) {
        ctx.ui.notify(warning, "warning");
      } else {
        console.error(warning);
      }
    }

    let decision: ReturnType<typeof evaluateRead> | undefined;

    if (isToolCallEventType("read", event)) {
      decision = evaluateRead(
        effectivePolicy,
        resolveToolPath(event.input.path, ctx.cwd),
        "file",
      );
    } else if (isToolCallEventType("grep", event)) {
      decision = evaluateRead(
        effectivePolicy,
        resolveToolPath(event.input.path ?? ".", ctx.cwd),
        "directory",
      );
    } else if (isToolCallEventType("find", event)) {
      decision = evaluateRead(
        effectivePolicy,
        resolveToolPath(event.input.path ?? ".", ctx.cwd),
        "directory",
      );
    } else if (isToolCallEventType("ls", event)) {
      decision = evaluateRead(
        effectivePolicy,
        resolveToolPath(event.input.path ?? ".", ctx.cwd),
        "directory",
      );
    } else if (isToolCallEventType("write", event)) {
      decision = evaluateWrite(
        effectivePolicy,
        resolveToolPath(event.input.path, ctx.cwd),
      );
    } else if (isToolCallEventType("edit", event)) {
      const requestedPath = resolveToolPath(event.input.path, ctx.cwd);
      const readDecision = evaluateRead(
        effectivePolicy,
        requestedPath,
        "file",
      );
      decision = readDecision.allowed
        ? evaluateWrite(effectivePolicy, requestedPath)
        : readDecision;
    }

    if (decision && !decision.allowed) {
      return {
        block: true,
        reason:
          `Mikoto Policy denied this tool call. See ${PERMISSION_PATH}.`,
      };
    }
  });
}
