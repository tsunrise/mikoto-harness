import type { MikotoPolicyDocument } from "mikoto-types";
import { getCanonicalPath } from "./canonical-path.ts";
import { isSameOrDescendant } from "./path-comparison.ts";

/**
 * Resolve lexical filesystem rule paths into the canonical paths accepted by
 * policy evaluation. Missing suffixes are supported by getCanonicalPath().
 * Rules that cannot be resolved are omitted and returned as warnings.
 */
export function resolvePolicyFileSystemCanonicalPaths(
  policy: MikotoPolicyDocument,
): {
  readonly document: MikotoPolicyDocument;
  readonly warnings: readonly string[];
} {
  const warnings = new Set<string>();
  const filesystem = policy.filesystem;
  const document = Object.freeze({
    filesystem: Object.freeze({
      denyRead: resolveRules(filesystem.denyRead, false, warnings),
      allowRead: resolveRules(filesystem.allowRead, true, warnings),
      allowWrite: resolveRules(filesystem.allowWrite, true, warnings),
      denyWrite: resolveRules(filesystem.denyWrite, false, warnings),
    }),
  });

  return Object.freeze({
    document,
    warnings: Object.freeze([...warnings]),
  });
}

function resolveRules(
  lexicalPaths: readonly string[],
  validateAllowBoundary: boolean,
  warnings: Set<string>,
): readonly string[] {
  const canonicalPaths = new Set<string>();

  for (const lexicalPath of lexicalPaths) {
    try {
      const canonicalPath = getCanonicalPath(lexicalPath);
      if (
        validateAllowBoundary &&
        !isValidAllowRulePath(lexicalPath, canonicalPath)
      ) {
        warnings.add(lexicalPath);
        continue;
      }
      canonicalPaths.add(canonicalPath);
    } catch {
      warnings.add(lexicalPath);
    }
  }

  return Object.freeze([...canonicalPaths]);
}

function isValidAllowRulePath(
  lexicalPath: string,
  canonicalPath: string,
): boolean {
  // An allow rule cannot grant access outside its configured lexical tree.
  if (isSameOrDescendant(lexicalPath, canonicalPath)) return true;

  // macOS exposes these aliases without treating them as trust expansion.
  if (
    lexicalPath === "/tmp" ||
    lexicalPath.startsWith("/tmp/") ||
    lexicalPath === "/var" ||
    lexicalPath.startsWith("/var/")
  ) {
    return isSameOrDescendant(
      `/private${lexicalPath}`,
      canonicalPath,
    );
  }

  return false;
}
