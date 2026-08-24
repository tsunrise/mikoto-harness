import {
  access,
  readFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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

export type MikotoPolicyLoadResult = {
  readonly document: MikotoPolicyDocument;
  readonly warnings: readonly string[];
};

export class MikotoPolicyDocumentLoader {
  private readonly bundledConfig: MikotoPolicyConfig;
  private readonly globalConfigPath: string;
  /**
   * undefined: not loaded yet
   * { valid: true, path }: file is missing
   * { valid: true, path, config }: valid file loaded
   * { valid: false, path, warnings }: file exists but invalid
   */
  private globalConfigState: undefined | {
    valid: true
    path: string
    config: MikotoPolicyConfig | undefined
  } | {
    valid: false
    path: string
    warnings: readonly string[]
  }
  private latestMergedPolicy?: {
    readonly cwd: string;
    readonly cwdTrusted: boolean;
    readonly workspaceConfigPath: string;
    readonly result: MikotoPolicyLoadResult;
  };

  constructor(
    bundledConfig: MikotoPolicyConfig,
    globalConfigPath = path.join(
      getAgentDir(),
      "mikoto-policy.json",
    ),
  ) {
    this.bundledConfig = bundledConfig;
    this.globalConfigPath = globalConfigPath;
  }

  async load(
    cwd: string,
    cwdTrusted: boolean,
  ): Promise<MikotoPolicyLoadResult> {
    const normalizedCwd = path.resolve(cwd);
    if (
      normalizedCwd === this.latestMergedPolicy?.cwd &&
      cwdTrusted === this.latestMergedPolicy.cwdTrusted
    ) {
      return this.latestMergedPolicy.result;
    }

    if (this.globalConfigState === undefined) {
      try {
        this.globalConfigState = {
          valid: true,
          path: this.globalConfigPath,
          config: MikotoPolicyConfig.parse(
            JSON.parse(await readFile(this.globalConfigPath, "utf8")),
          ),
        };
      } catch (error) {
        this.globalConfigState = isMissingFileError(error)
          ? {
              valid: true,
              path: this.globalConfigPath,
              config: undefined,
            }
          : {
              valid: false,
              path: this.globalConfigPath,
              warnings: Object.freeze([
                invalidPolicyWarning(this.globalConfigPath, error),
              ]),
            };
      }
    }

    const layers = [this.bundledConfig];
    const warnings: string[] = [];
    if (this.globalConfigState.valid) {
      if (this.globalConfigState.config) {
        layers.push(this.globalConfigState.config);
      }
    } else {
      warnings.push(...this.globalConfigState.warnings);
    }
    const workspaceConfigPath = path.join(
      normalizedCwd,
      "mikoto-policy.json",
    );

    if (this.globalConfigState.valid) {
      // Only load workspace config if globalConfig is valid (exists and compliant, or missing)
      if (cwdTrusted) {
        try {
          layers.push(
            MikotoPolicyConfig.parse(
              JSON.parse(await readFile(workspaceConfigPath, "utf8")),
            ),
          );
        } catch (error) {
          if (!isMissingFileError(error)) {
            warnings.push(invalidPolicyWarning(workspaceConfigPath, error));
          }
        }
      } else {
        try {
          await access(workspaceConfigPath);
          warnings.push(
            `Mikoto Policy skipped ${workspaceConfigPath} because the workspace is not trusted.`,
          );
        } catch (error) {
          if (!isMissingFileError(error)) {
            warnings.push(
              `Mikoto Policy could not inspect ${workspaceConfigPath}: ${policyErrorMessage(error)}`,
            );
          }
        }
      }
    }

    const result = Object.freeze({
      document: mergePolicyConfigs(layers, { cwd: normalizedCwd }),
      warnings: Object.freeze(warnings),
    });
    this.latestMergedPolicy = {
      cwd: normalizedCwd,
      cwdTrusted,
      workspaceConfigPath,
      result,
    };
    return result;
  }

  async debugLoad(
    cwd: string,
    cwdTrusted: boolean,
  ): Promise<MikotoPolicyLoadResult & {
    readonly globalConfigPath: string;
    readonly workspaceConfigPath: string;
  }> {
    const result = await this.load(cwd, cwdTrusted);
    if (!this.globalConfigState || !this.latestMergedPolicy) {
      throw new Error("Policy state was not loaded.");
    }
    return Object.freeze({
      ...result,
      globalConfigPath: this.globalConfigState.path,
      workspaceConfigPath: this.latestMergedPolicy.workspaceConfigPath,
    });
  }
}

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

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function invalidPolicyWarning(
  configPath: string,
  error: unknown,
): string {
  return `Mikoto Policy ignored invalid policy at ${configPath}: ${policyErrorMessage(error)}`;
}

function policyErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        const issuePath = issue.path.length > 0
          ? issue.path.join(".")
          : "document";
        return `${issuePath}: ${issue.message}`;
      })
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}
