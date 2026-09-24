import type { MikotoPolicyDocument, MikotoPolicyLoadDiagnostic } from "mikoto-types";
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
  readonly diagnostics: readonly MikotoPolicyLoadDiagnostic[];
} {
  const warnings = new Set<string>();
  const diagnostics: MikotoPolicyLoadDiagnostic[] = [];
  const filesystem = policy.filesystem;
  const document = Object.freeze({
    network: Object.freeze({
      allowedDomains: Object.freeze([...policy.network.allowedDomains]),
      deniedDomains: Object.freeze([...policy.network.deniedDomains]),
      allowLocalBinding: policy.network.allowLocalBinding,
      // Socket paths are commonly symlinks into another tree (for example,
      // /var/run/docker.sock). Grant the canonical target the user named
      // rather than applying the filesystem allow-boundary check.
      allowUnixSockets: resolveRules(
        policy.network.allowUnixSockets, false, warnings, diagnostics, "allowUnixSockets",
      ),
    }),
    filesystem: Object.freeze({
      denyRead: resolveRules(filesystem.denyRead, false, warnings, diagnostics, "denyRead"),
      allowRead: resolveRules(filesystem.allowRead, true, warnings, diagnostics, "allowRead"),
      allowWrite: resolveRules(filesystem.allowWrite, true, warnings, diagnostics, "allowWrite"),
      denyWrite: resolveRules(filesystem.denyWrite, false, warnings, diagnostics, "denyWrite"),
    }),
  });

  return Object.freeze({
    document,
    warnings: Object.freeze([...warnings]),
    diagnostics: Object.freeze(diagnostics),
  });
}

function resolveRules(
  lexicalPaths: readonly string[],
  validateAllowBoundary: boolean,
  warnings: Set<string>,
  diagnostics: MikotoPolicyLoadDiagnostic[],
  rule: keyof MikotoPolicyDocument["filesystem"] | "allowUnixSockets",
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
        diagnostics.push(Object.freeze({ kind: "canonical_rule", rule, path: lexicalPath }));
        continue;
      }
      canonicalPaths.add(canonicalPath);
    } catch {
      warnings.add(lexicalPath);
      diagnostics.push(Object.freeze({ kind: "canonical_rule", rule, path: lexicalPath }));
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
