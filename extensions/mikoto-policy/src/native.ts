import { homedir } from "node:os";
import nodePath from "node:path";
import {
  isToolCallEventType,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  mergePolicyConfigs,
  type MikotoPolicyConfig,
} from "./config.ts";
import {
  evaluateRead,
  evaluateWrite,
} from "./evaluate.ts";

export function enforcePiNativeTools(policy: MikotoPolicyConfig, pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    const effectivePolicy = mergePolicyConfigs([policy], { cwd: ctx.cwd });
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
        reason: "Mikoto Policy denied this tool call.",
      };
    }
  });
}

function resolveToolPath(toolPath: string, cwd: string): string {
  let resolvedPath = toolPath.replace(
    /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g,
    " ",
  );
  if (resolvedPath.startsWith("@")) resolvedPath = resolvedPath.slice(1);
  if (resolvedPath === "~") {
    resolvedPath = homedir();
  } else if (resolvedPath.startsWith("~/")) {
    resolvedPath = nodePath.join(homedir(), resolvedPath.slice(2));
  }
  return nodePath.resolve(cwd, resolvedPath);
}
