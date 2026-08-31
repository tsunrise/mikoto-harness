import {
  lstatSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import nodePath from "node:path";

const MAX_SYMLINK_DEPTH = 40;

/**
 * Return the absolute path after resolving existing and dangling symlinks.
 * Missing suffixes are appended to their deepest canonical ancestor.
 */
export function getCanonicalPath(lexicalPath: string): string {
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

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
