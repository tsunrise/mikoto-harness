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
    let denyRuleIndex: number | undefined;

    for (
      let index = 0;
      index < canonicalized.policy.filesystem.denyRead.length;
      index++
    ) {
      if (
        matchesPolicyPath(
          canonicalized.policy.filesystem.denyRead[index],
          requestCanonicalPath,
          entity,
        )
      ) {
        denyRuleIndex = index;
        break;
      }
    }

    if (denyRuleIndex === undefined) return { allowed: true };

    for (const allowPath of canonicalized.policy.filesystem.allowRead) {
      if (matchesPolicyPath(allowPath, requestCanonicalPath, entity)) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      deniedPath: policy.filesystem.denyRead[denyRuleIndex],
    };
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
        matchesPolicyPath(
          canonicalized.policy.filesystem.denyWrite[index],
          requestCanonicalPath,
          "file",
        )
      ) {
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
        matchesPolicyPath(
          canonicalized.policy.filesystem.allowWrite[index],
          requestCanonicalPath,
          "file",
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
  if (isSameOrDescendant(ruleLexicalPath, ruleCanonicalPath)) return true;

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

function matchesPolicyPath(
  ruleCanonicalPath: string,
  requestCanonicalPath: string,
  requestEntity: "file" | "directory",
): boolean {
  if (isSameOrDescendant(ruleCanonicalPath, requestCanonicalPath)) return true;
  return (
    requestEntity === "directory" &&
    isSameOrDescendant(requestCanonicalPath, ruleCanonicalPath)
  );
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
