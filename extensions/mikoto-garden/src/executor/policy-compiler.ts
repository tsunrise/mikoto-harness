import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { MikotoPolicyDocument } from "mikoto-types";

export const within = (root: string, target: string): boolean =>
  target === root || target.startsWith(root === "/" ? "/" : `${root}/`);
export async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A dangling symlink is not a missing suffix and must not be accepted as
    // a pinned literal rule.
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("Dangling policy symlink");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), path.slice(parent.length));
  }
}
export async function checkPolicyPaths(document: MikotoPolicyDocument): Promise<void> {
  for (const paths of Object.values(document.filesystem)) {
    for (const path of paths) {
      if (resolve(path) !== path || /[\0*?[\]]/.test(path) || (await canonical(path)) !== path) {
        throw new Error("Unsupported policy path or canonical-path drift");
      }
    }
  }
}

// SRT's literal branch re-emits nested denies after *all* allows. Its glob
// branch instead subtracts the allows covered by each deny. Encode one fixed
// character as a singleton class to select that branch without changing the
// matched region. Gate 1 checks the emitted OS behavior, not just these arrays.
export function exactReadRegion(path: string): string {
  if (path === "/") return path;
  if (path.includes("__GLOBSTAR") || /[\n\r]/.test(path)) {
    throw new Error("Unsupported path spelling for SRT translation");
  }
  const last = path.lastIndexOf("/");
  const leaf = path.slice(last + 1);
  const index = leaf.search(/[a-zA-Z0-9_-]/);
  if (index < 0) throw new Error("Unsupported read-deny path for exact-region translation");
  const char = leaf[index];
  return path.slice(0, last + 1) + leaf.slice(0, index) + `[${char}]` + leaf.slice(index + 1);
}

export async function compilePolicy(
  document: MikotoPolicyDocument,
  control: string,
  scratch: string,
) {
  if (process.platform !== "darwin") throw new Error("Command execution supports macOS only");
  await checkPolicyPaths(document);
  const fs = document.filesystem;
  if (
    fs.denyWrite.some((root) => within(root, scratch)) ||
    fs.denyRead.some((root) => within(root, scratch))
  ) {
    throw new Error("Policy denies private runtime scratch; unsupported runtime storage policy");
  }
  // SRT always adds these Claude Code compatibility write grants, even when
  // we supply a custom allowWrite list. Garden does not run Claude Code, so we
  // neutralize the grants unless Policy explicitly permits them.
  // `/tmp/claude` canonicalizes to `/private/tmp/claude` on macOS.
  const implicit = [
    "/private/tmp/claude",
    join(homedir(), ".npm/_logs"),
    join(homedir(), ".claude/debug"),
  ];
  const extraDenies: string[] = [];
  for (const lexical of implicit) {
    const path = await canonical(lexical);
    if (fs.allowWrite.some((root) => within(root, path))) continue;
    if (fs.allowWrite.some((root) => within(path, root))) {
      throw new Error(
        "Partial allow within an implicit SRT write grant cannot be represented safely",
      );
    }
    extraDenies.push(path);
  }
  const denyRead = [...fs.denyRead.filter((deny) => !fs.allowRead.includes(deny)), control];
  const filesystem = {
    denyRead: denyRead.map(exactReadRegion),
    allowRead: fs.allowRead.filter((root) => !within(control, root)),
    allowWrite: [...fs.allowWrite, scratch],
    denyWrite: [...fs.denyWrite, ...extraDenies, control],
  };
  return {
    filesystem,
    diagnostics: [
      "Directory metadata remains readable for runtime traversal; literal / may be enumerated.",
      "SRT mandatory device access and additional write/move protections remain in force.",
      "Private control/log storage is protected; scratch is the only automatic ordinary directory write grant.",
      "Shell directory enumeration is not native evaluateReadTree preflight.",
    ],
  };
}
