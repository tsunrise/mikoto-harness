import { homedir } from "node:os";
import nodePath from "node:path";

/**
 * @param toolPath Relative path in cwd or absolute path. Could contain symlinks.
 * @param cwd Current working directory
 * @returns Lexical absolute path
 */
export function resolveToolPath(toolPath: string, cwd: string): string {
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
