import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MikotoPolicyDocument } from "mikoto-types";
import { z } from "zod";

export const BUNDLED_POLICY_PATH = fileURLToPath(
  new URL("../mikoto-policy.default.json", import.meta.url),
);

const FsPath = z
  .string()
  .min(1, "Path cannot be empty.")
  .regex(
    /^[^\u0000*?\[\]]+$/,
    "Paths must be literal and cannot contain NUL or glob metacharacters (*, ?, [, ]).",
  )
  .describe(
    "Literal absolute, cwd-relative, or home-relative filesystem path.",
  );
type FsPath = z.infer<typeof FsPath>;

const FsPathArray = z.array(FsPath);
type FsPathArray = z.infer<typeof FsPathArray>;

const DeltaFsPathArray = z
  .union([
    z.strictObject({
      "+": FsPathArray,
      "-": FsPathArray,
    }),
    z.strictObject({
      "+": FsPathArray,
    }),
    z.strictObject({
      "-": FsPathArray,
    }),
  ])
  .describe("Add and/or remove exact path strings from the previous layer.");
type DeltaFsPathArray = z.infer<typeof DeltaFsPathArray>;

const MergableFsPathArray = z
  .union([FsPathArray, DeltaFsPathArray])
  .describe(
    "A replacement array or an object that adds and/or removes exact path strings.",
  );
type MergableFsPathArray = z.infer<typeof MergableFsPathArray>;

const FilesystemConfig = z
  .strictObject({
    denyRead: MergableFsPathArray
      .optional()
      .describe("Paths denied for reading."),
    allowRead: MergableFsPathArray
      .optional()
      .describe("Paths re-allowed within denied read regions."),
    allowWrite: MergableFsPathArray
      .optional()
      .describe("Paths allowed for writing."),
    denyWrite: MergableFsPathArray
      .optional()
      .describe("Paths denied for writing within allowed write regions."),
  })
  .describe("Filesystem policy. Read is allowed in default, and follow deny-and-allow pattern. Write is denied by default, and follow allow-and-deny pattern.");
type FilesystemConfig = z.infer<typeof FilesystemConfig>;

export const MikotoPolicyConfig = z
  .strictObject({
    $schema: z
      .string()
      .optional()
      .describe("Optional JSON Schema URI."),
    filesystem: FilesystemConfig.optional(),
  })
  .meta({
    title: "Mikoto Policy",
    description:
      "Policy enforced in Mikoto Harness.",
  });

export type MikotoPolicyConfig = z.infer<typeof MikotoPolicyConfig>;

export function mergePolicyConfigs(
  layers: readonly MikotoPolicyConfig[],
  options: {
    readonly cwd: string;
    readonly homeDir?: string;
  },
): MikotoPolicyDocument {
  const merged = {
    denyRead: [] as FsPath[],
    allowRead: [] as FsPath[],
    allowWrite: [] as FsPath[],
    denyWrite: [] as FsPath[],
  };

  for (const layer of layers) {
    const filesystem: FilesystemConfig | undefined = layer.filesystem;
    if (!filesystem) continue;

    if (filesystem.denyRead !== undefined) {
      merged.denyRead = mergePathArray(merged.denyRead, filesystem.denyRead);
    }
    if (filesystem.allowRead !== undefined) {
      merged.allowRead = mergePathArray(
        merged.allowRead,
        filesystem.allowRead,
      );
    }
    if (filesystem.allowWrite !== undefined) {
      merged.allowWrite = mergePathArray(
        merged.allowWrite,
        filesystem.allowWrite,
      );
    }
    if (filesystem.denyWrite !== undefined) {
      merged.denyWrite = mergePathArray(
        merged.denyWrite,
        filesystem.denyWrite,
      );
    }
  }

  const homeDir = options.homeDir ?? homedir();
  const filesystem = Object.freeze({
    denyRead: normalizeAndFreeze(merged.denyRead, options.cwd, homeDir),
    allowRead: normalizeAndFreeze(merged.allowRead, options.cwd, homeDir),
    allowWrite: normalizeAndFreeze(merged.allowWrite, options.cwd, homeDir),
    denyWrite: normalizeAndFreeze(merged.denyWrite, options.cwd, homeDir),
  });

  return Object.freeze({ filesystem });
}

/**
 * A plain array replaces the previous value. A delta applies `+` then `-`.
 * Removal wins when both `+` and `-` contain a path.
 */
function mergePathArray(
  previous: readonly FsPath[],
  next: MergableFsPathArray,
): FsPath[] {
  if (isFsPathArray(next)) return [...new Set(next)];

  const result = new Set(previous);
  if ("+" in next) {
    for (const added of next["+"]) result.add(added);
  }
  if ("-" in next) {
    for (const removed of next["-"]) result.delete(removed);
  }
  return [...result];
}

function isFsPathArray(
  value: FsPathArray | DeltaFsPathArray,
): value is FsPathArray {
  return Array.isArray(value);
}

function normalizeAndFreeze(
  configuredPaths: readonly FsPath[],
  cwd: string,
  homeDir: string,
): readonly string[] {
  const normalizedPaths = configuredPaths.map((configuredPath) =>
    normalizePolicyPath(configuredPath, cwd, homeDir),
  );
  return Object.freeze([...new Set(normalizedPaths)]);
}

function normalizePolicyPath(
  configuredPath: FsPath,
  cwd: string,
  homeDir: string,
): string {
  let expandedPath = configuredPath;
  if (configuredPath === "~") {
    expandedPath = homeDir;
  } else if (configuredPath.startsWith("~/")) {
    expandedPath = path.join(homeDir, configuredPath.slice(2));
  }

  return path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(cwd, expandedPath);
}
