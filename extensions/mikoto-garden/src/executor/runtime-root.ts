import { lstat, realpath, rm } from "node:fs/promises";

export async function cleanupOwnedRuntimeRoot(
  root: string,
  rootInode: number | undefined,
  warnings: string[],
): Promise<void> {
  // Only the mkdtemp-owned generation directory can be removed. Refuse a
  // replaced path instead of following a workload-created alias.
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.ino !== rootInode || (await realpath(root)) !== root) {
      throw new Error("Runtime identity changed");
    }
    await rm(root, { recursive: true, force: true });
  } catch {
    warnings.push(`Owned runtime artifacts retained: ${root}`);
  }
}
