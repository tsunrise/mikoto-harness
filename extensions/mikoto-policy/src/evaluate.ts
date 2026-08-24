import {
  lstatSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import nodePath from "node:path";
import type { MikotoPolicyDocument } from "mikoto-types";

type EvaluationResult =
  | { allowed: true }
  | { allowed: false; deniedPath: string };

const MAX_SYMLINK_DEPTH = 40;

export function evaluateRead(
  policy: MikotoPolicyDocument,
  path: string,
  entity: "file" | "directory",
): EvaluationResult {
  try {
    const canonicalized = canonicalizeFsPolicyAndRequestPaths(
      policy,
      path,
      "read",
    );
    const requestCanonicalPath = canonicalized.requestPath;
    const denyPaths = canonicalized.policy.filesystem.denyRead;
   // Suupose we have a denyRead rule `project/secret`, we want to reject the directory read request
   // `project/` is `secret` is contained in here.
   // We don't want to enumerate all items in `project/` as paths being checked so see if they match any denyRead rule.
   // Instead, we just enumerate `denyRead` paths that are inside `project/`.
    const effectiveRequestPaths = entity === "file"
      ? [requestCanonicalPath]
      : [
          requestCanonicalPath,
          ...denyPaths.filter((denyPath) =>
            isSameOrDescendant(requestCanonicalPath, denyPath)
          ),
        ];

    for (const effectiveRequestPath of new Set(effectiveRequestPaths)) {
      let denyRuleIndex: number | undefined;

      for (let index = 0; index < denyPaths.length; index++) {
        if (!isSameOrDescendant(denyPaths[index], effectiveRequestPath)) {
          continue;
        }
        if (
          denyRuleIndex === undefined ||
          isSameOrDescendant(denyPaths[denyRuleIndex], denyPaths[index])
        ) {
          denyRuleIndex = index;
          // We don't break here, because we want to find deepest match
          // For example, if both `/a` and `/a/b/c` deny rule match,
          // we use `/a/b/c`.
          //
          // Using deepest match is required here because we require an allow rule
          // to only be effective if  it is equal or more specific than the most specifically
          // matched deny rule. For example, suppose we have allow rule `/a/b` and request
          // is `/a/b/c/file`. The request is still rejected because allow rule `/a/b` is less
          // specific than most specifically matched deny rule `/a/b/c`.
          //
        }
      }

      if (denyRuleIndex === undefined) continue;

      const denyPath = denyPaths[denyRuleIndex];
      const isAllowed = canonicalized.policy.filesystem.allowRead.some(
        (allowPath) =>
          // We require the effectiveRequestPath is equal to or is a desendant of allow path
          isSameOrDescendant(allowPath, effectiveRequestPath) &&
          // Also require the allow path to be more specific than denyPath (also described in previous inline comment
          // on why we have to choose the deepest matched deny rule instead of first match)
          isSameOrDescendant(denyPath, allowPath),
      );
      if (!isAllowed) {
        return {
          allowed: false,
          deniedPath: policy.filesystem.denyRead[denyRuleIndex],
        };
      }
    }

    return { allowed: true };
  } catch {
    return { allowed: false, deniedPath: path };
  }
}

export function evaluateWrite(
  policy: MikotoPolicyDocument,
  path: string,
): EvaluationResult {
  try {
    const canonicalized = canonicalizeFsPolicyAndRequestPaths(
      policy,
      path,
      "write",
    );
    const requestCanonicalPath = canonicalized.requestPath;

    for (
      let index = 0;
      index < canonicalized.policy.filesystem.denyWrite.length;
      index++
    ) {
      if (
        isSameOrDescendant(
          canonicalized.policy.filesystem.denyWrite[index],
          requestCanonicalPath,
        )
      ) {
        // Unlike read, we don't match most specific path here.
        // Match semantic is deny default -> allow then deny
        // But we evaluate deny rules first if a file matches a deny,
        // we could just reject without need to evaluating allow.
        return {
          allowed: false,
          deniedPath: policy.filesystem.denyWrite[index],
        };
      }
    }

    for (
      let index = 0;
      index < canonicalized.policy.filesystem.allowWrite.length;
      index++
    ) {
      if (
        isSameOrDescendant(
          canonicalized.policy.filesystem.allowWrite[index],
          requestCanonicalPath,
        )
      ) {
        return { allowed: true };
      }
    }

    return { allowed: false, deniedPath: path };
  } catch {
    return { allowed: false, deniedPath: path };
  }
}

/**
 * Resolve symlinks in the requested path and rules used by this operation.
 * Deny resolution errors throw. Invalid or unresolvable allows are omitted.
 */
function canonicalizeFsPolicyAndRequestPaths(
  fs: Pick<MikotoPolicyDocument, "filesystem">,
  requestPath: string,
  operation: "read" | "write",
): {
  policy: Pick<MikotoPolicyDocument, "filesystem">;
  requestPath: string;
} {
  const requestCanonicalPath = getCanonicalPath(requestPath);

  if (operation === "read") {
    return {
      policy: {
        filesystem: {
          denyRead: fs.filesystem.denyRead.map(getCanonicalPath),
          allowRead: canonicalizeAllowRules(fs.filesystem.allowRead),
          allowWrite: [],
          denyWrite: [],
        },
      },
      requestPath: requestCanonicalPath,
    };
  }

  return {
    policy: {
      filesystem: {
        denyRead: [],
        allowRead: [],
        allowWrite: canonicalizeAllowRules(fs.filesystem.allowWrite),
        denyWrite: fs.filesystem.denyWrite.map(getCanonicalPath),
      },
    },
    requestPath: requestCanonicalPath,
  };
}

function canonicalizeAllowRules(
  lexicalPaths: readonly string[],
): readonly string[] {
  const canonicalPaths: string[] = [];

  for (const lexicalPath of lexicalPaths) {
    try {
      const canonicalPath = getCanonicalPath(lexicalPath);
      if (isValidAllowRulePath(lexicalPath, canonicalPath)) {
        canonicalPaths.push(canonicalPath);
      }
    } catch {
      // An uncertain allow rule grants nothing.
    }
  }

  return canonicalPaths;
}

/**
 * Return the absolute path after resolving existing and dangling symlinks.
 * Missing suffixes are appended to their deepest canonical ancestor.
 */
function getCanonicalPath(lexicalPath: string): string {
  if (!nodePath.isAbsolute(lexicalPath)) {
    throw new Error(`Expected an absolute path: ${lexicalPath}`);
  }

  let currentPath = nodePath.normalize(lexicalPath);
  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
    try {
      return realpathSync(currentPath);
    } catch {
      // Resolve the deepest existing ancestor below.
    }

    let ancestorPath = currentPath;
    const remainder: string[] = [];
    let canonicalAncestor: string | undefined;

    while (canonicalAncestor === undefined) {
      const parentPath = nodePath.dirname(ancestorPath);
      if (parentPath === ancestorPath) {
        throw new Error(`Cannot resolve path: ${lexicalPath}`);
      }

      remainder.unshift(nodePath.basename(ancestorPath));
      ancestorPath = parentPath;
      try {
        canonicalAncestor = realpathSync(ancestorPath);
      } catch {
        // Continue towards the root.
      }
    }

    const firstUnresolvedPath = nodePath.join(
      canonicalAncestor,
      remainder[0],
    );
    let firstUnresolvedStats: ReturnType<typeof lstatSync>;
    try {
      firstUnresolvedStats = lstatSync(firstUnresolvedPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return nodePath.join(canonicalAncestor, ...remainder);
      }
      throw error;
    }

    if (!firstUnresolvedStats.isSymbolicLink()) {
      throw new Error(`Cannot resolve path: ${lexicalPath}`);
    }

    const linkTarget = readlinkSync(firstUnresolvedPath);
    currentPath = nodePath.join(
      nodePath.resolve(nodePath.dirname(firstUnresolvedPath), linkTarget),
      ...remainder.slice(1),
    );
  }

  throw new Error(`Too many symlinks while resolving: ${lexicalPath}`);
}

function isValidAllowRulePath(
  ruleLexicalPath: string,
  ruleCanonicalPath: string,
): boolean {
  // An allow rule is valid iff
  // - Its canonical path (i.e. symlink resolved path) equal to or a descendant of its lexical path.
  //   Note that a canonical path being a descendant of its lexical path (e.g. /tmp/claude -> /tmp/claude/actual)
  //   would produce an ELOOP but we guard them anyway, as a defensive thing.
  if (isSameOrDescendant(ruleLexicalPath, ruleCanonicalPath)) return true;

  // Special case for MacOS, while we intentionally have this special case across platform, for consistency.
  if (
    ruleLexicalPath === "/tmp" ||
    ruleLexicalPath.startsWith("/tmp/") ||
    ruleLexicalPath === "/var" ||
    ruleLexicalPath.startsWith("/var/")
  ) {
    return isSameOrDescendant(
      `/private${ruleLexicalPath}`,
      ruleCanonicalPath,
    );
  }

  return false;
}

function isSameOrDescendant(
  parentPath: string,
  candidatePath: string,
): boolean {
  if (candidatePath === parentPath) return true;
  const prefix = parentPath === "/" ? "/" : `${parentPath}${nodePath.sep}`;
  return candidatePath.startsWith(prefix);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
