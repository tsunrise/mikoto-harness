import type { MikotoPolicyDocument } from "mikoto-types";
import { isSameOrDescendant } from "./path-comparison.ts";

export type EvaluationResult =
  | { allowed: true }
  | { allowed: false; deniedPath: string };

/**
 * Evaluate an absolute normalized canonical path without inspecting the
 * filesystem. The caller owns canonical-path resolution and enforcement.
 */
export function evaluateRead(
  policy: MikotoPolicyDocument,
  canonicalPath: string,
  entity: "file" | "directory",
): EvaluationResult {
  const denyRules = policy.filesystem.denyRead;

  // Suupose we have a denyRead rule `project/secret`, we want to reject the directory read request
  // `project/` is `secret` is contained in here.
  // We don't want to enumerate all items in `project/` as paths being checked so see if they match any denyRead rule.
  // Instead, we just enumerate `denyRead` paths that are inside `project/`.
  const effectiveRequestPaths = entity === "file"
    ? [canonicalPath]
    : [
        canonicalPath,
        ...denyRules
          .filter((denyPath) =>
            isSameOrDescendant(canonicalPath, denyPath)
          ),
      ];

  for (const effectiveRequestPath of new Set(effectiveRequestPaths)) {
    let denyRule: string | undefined;

    for (const candidateRule of denyRules) {
      if (
        !isSameOrDescendant(
          candidateRule,
          effectiveRequestPath,
        )
      ) {
        continue;
      }
      if (
        denyRule === undefined ||
        isSameOrDescendant(
          denyRule,
          candidateRule,
        )
      ) {
        denyRule = candidateRule;
      }
    }

    if (denyRule === undefined) continue;

    const isAllowed = policy.filesystem.allowRead.some(
      (allowRule) =>
        isSameOrDescendant(
          allowRule,
          effectiveRequestPath,
        ) &&
        isSameOrDescendant(
          denyRule,
          allowRule,
        ),
    );
    if (!isAllowed) {
      return {
        allowed: false,
        deniedPath: denyRule,
      };
    }
  }

  return { allowed: true };
}

/**
 * Evaluate an absolute normalized canonical path without inspecting the
 * filesystem. The caller owns canonical-path resolution and enforcement.
 */
export function evaluateWrite(
  policy: MikotoPolicyDocument,
  canonicalPath: string,
): EvaluationResult {
  const denyRules = policy.filesystem.denyWrite;

  for (const denyRule of denyRules) {
    if (
      isSameOrDescendant(denyRule, canonicalPath)
    ) {
      return {
        allowed: false,
        deniedPath: denyRule,
      };
    }
  }

  for (const allowRule of policy.filesystem.allowWrite) {
    if (
      isSameOrDescendant(allowRule, canonicalPath)
    ) {
      return { allowed: true };
    }
  }

  return { allowed: false, deniedPath: canonicalPath };
}
