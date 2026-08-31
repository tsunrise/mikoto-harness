import nodePath from "node:path";

export function isSameOrDescendant(
  parentPath: string,
  candidatePath: string,
): boolean {
  if (candidatePath === parentPath) return true;
  const prefix = parentPath === nodePath.parse(parentPath).root
    ? parentPath
    : `${parentPath}${nodePath.sep}`;
  return candidatePath.startsWith(prefix);
}
