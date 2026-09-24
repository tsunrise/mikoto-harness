import {
  access,
  readFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MikotoPolicyDocument, MikotoPolicyLoadDiagnostic } from "mikoto-types";
import { z } from "zod";
import { resolvePolicyFileSystemCanonicalPaths } from "./resolve-policy-paths.ts";

export const BUNDLED_POLICY_PATH = fileURLToPath(
  new URL("../mikoto-policy.default.json", import.meta.url),
);

export const PERMISSION_PATH = fileURLToPath(
  new URL("../PERMISSION.md", import.meta.url),
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

/** Keep this syntax aligned with the declaration-only Policy contract. */
export function normalizeNetworkRule(value: string, deny: boolean): string | undefined {
  if (!value || value !== value.trim() || value.length > 260) return undefined;
  const parts = value.toLowerCase().split(":");
  if (parts.length > 2) return undefined;
  const [host, port] = parts;
  if (port !== undefined && (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535)) return undefined;
  if (host === "*") return deny ? value.toLowerCase() : undefined;
  const dns = host.startsWith("*.") ? host.slice(2) : host;
  if (/^[\d.]+$/.test(dns)) {
    if (host !== dns || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(dns) ||
      dns.split(".").some((part) => Number(part) > 255)) return undefined;
  } else {
    if (dns.length > 253 || !dns.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined;
    // Numeric final labels have ambiguous inet_aton/URL interpretations.
    if (/^\d+$/.test(dns.split(".").at(-1)!)) return undefined;
    try { if (new URL(`http://${dns}`).hostname !== dns) return undefined; }
    catch { return undefined; }
  }
  return value.toLowerCase();
}

function networkArray(deny: boolean) {
  const rule = z.string().refine((value) => normalizeNetworkRule(value, deny) !== undefined,
    "Expected a DNS/IPv4 destination with optional port; wildcard-all is deny-only.")
    .overwrite((value) => normalizeNetworkRule(value, deny)!);
  const array = z.array(rule);
  return z.union([array, z.strictObject({ "+": array, "-": array }),
    z.strictObject({ "+": array }), z.strictObject({ "-": array })]);
}

const NetworkConfig = z.strictObject({
  allowedDomains: networkArray(false).optional(),
  deniedDomains: networkArray(true).optional(),
});

const AgentName = z.string().min(1).regex(/^\S(?:[\s\S]*\S)?$/,
  "Provider/model names must be nonblank with no surrounding whitespace.");
const ReviewAgent = z.strictObject({
  provider: AgentName,
  model: AgentName,
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
});
export type EscalationSettings = Readonly<{
  escalation: "ask-me" | "auto-review" | "always-deny";
  autoReview: Readonly<{ agent: Readonly<z.infer<typeof ReviewAgent>>; policy: readonly string[] }>;
}>;
export const DEFAULT_SETTINGS: EscalationSettings = Object.freeze({
  escalation: "ask-me",
  autoReview: Object.freeze({
    agent: Object.freeze({ provider: "openai-codex", model: "gpt-6-luna", thinkingLevel: "low" }),
    policy: Object.freeze([]),
  }),
});

export function mergeSettings(layers: readonly MikotoPolicyConfig[]): EscalationSettings {
  let { escalation, autoReview: { agent } } = DEFAULT_SETTINGS;
  // Custom rules accumulate in layer order; the reviewer is told that later
  // rules override conflicting earlier ones.
  const policy = [...DEFAULT_SETTINGS.autoReview.policy];
  for (const layer of layers) {
    escalation = layer.escalation ?? escalation;
    agent = layer.autoReview?.agent ?? agent;
    policy.push(...layer.autoReview?.policy ?? []);
  }
  return Object.freeze({
    escalation,
    autoReview: Object.freeze({ agent: Object.freeze({ ...agent }), policy: Object.freeze(policy) }),
  });
}

export const MikotoPolicyConfig = z
  .strictObject({
    $schema: z
      .string()
      .optional()
      .describe("Optional JSON Schema URI."),
    filesystem: FilesystemConfig.optional(),
    network: NetworkConfig.optional(),
    escalation: z.enum(["ask-me", "auto-review", "always-deny"]).optional(),
    autoReview: z.strictObject({
      agent: ReviewAgent.optional(),
      policy: z.array(z.string().trim().min(1)).optional()
        .describe("Custom reviewer rules. Layers concatenate; later rules override conflicting earlier ones."),
    }).optional(),
  })
  .meta({
    title: "Mikoto Policy",
    description:
      "Policy enforced in Mikoto Harness.",
  });

export type MikotoPolicyConfig = z.infer<typeof MikotoPolicyConfig>;

export type MikotoPolicyLoadResult = {
  readonly settings: EscalationSettings;
  readonly document: MikotoPolicyDocument;
  readonly warnings: readonly string[];
  readonly diagnostics: readonly MikotoPolicyLoadDiagnostic[];
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
    diagnostic: MikotoPolicyLoadDiagnostic
  }
  private readonly loadedPolicies = new Map<string, {
    readonly workspaceConfigPath: string;
    readonly result: MikotoPolicyLoadResult;
  }>();

  constructor(
    bundledConfig: MikotoPolicyConfig,
    globalConfigPath = path.join(
      getAgentDir(),
      "mikoto-policy.json",
    ),
  ) {
    this.bundledConfig = MikotoPolicyConfig.parse(bundledConfig);
    this.globalConfigPath = globalConfigPath;
  }

  async load(
    cwd: string,
    cwdTrusted: boolean,
  ): Promise<MikotoPolicyLoadResult> {
    const normalizedCwd = path.resolve(cwd);
    const cacheKey = policyCacheKey(normalizedCwd, cwdTrusted);
    const cached = this.loadedPolicies.get(cacheKey);
    if (cached) return cached.result;

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
              diagnostic: layerDiagnostic(this.globalConfigPath, error),
            };
      }
    }

    const layers = [this.bundledConfig];
    const warnings: string[] = [];
    const diagnostics: MikotoPolicyLoadDiagnostic[] = [];
    if (this.globalConfigState.valid) {
      if (this.globalConfigState.config) {
        layers.push(this.globalConfigState.config);
      } else {
        diagnostics.push({ kind: "optional_absence", path: this.globalConfigPath });
      }
    } else {
      warnings.push(...this.globalConfigState.warnings);
      diagnostics.push(this.globalConfigState.diagnostic);
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
            diagnostics.push(layerDiagnostic(workspaceConfigPath, error));
          } else {
            diagnostics.push({ kind: "optional_absence", path: workspaceConfigPath });
          }
        }
      } else {
        diagnostics.push({ kind: "untrusted_workspace", path: workspaceConfigPath });
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

    const mergedFileSystemPaths = mergePolicyConfigs(
      layers,
      { cwd: normalizedCwd },
    );
    const resolvedPolicy = resolvePolicyFileSystemCanonicalPaths(
      { filesystem: mergedFileSystemPaths, network: mergeNetwork(layers) },
    );
    warnings.push(...resolvedPolicy.warnings);
    const result = Object.freeze({
      settings: mergeSettings(layers),
      document: resolvedPolicy.document,
      warnings: Object.freeze(warnings),
      diagnostics: Object.freeze([...diagnostics, ...resolvedPolicy.diagnostics].map((d) => Object.freeze(d))),
    });
    this.loadedPolicies.set(cacheKey, {
      workspaceConfigPath,
      result,
    });
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
    const loadedPolicy = this.loadedPolicies.get(
      policyCacheKey(path.resolve(cwd), cwdTrusted),
    );
    if (!this.globalConfigState || !loadedPolicy) {
      throw new Error("Policy state was not loaded.");
    }
    return Object.freeze({
      ...result,
      globalConfigPath: this.globalConfigState.path,
      workspaceConfigPath: loadedPolicy.workspaceConfigPath,
    });
  }
}

function layerDiagnostic(configPath: string, error: unknown): MikotoPolicyLoadDiagnostic {
  return { kind: (error as NodeJS.ErrnoException)?.code ? "unreadable_layer" : "invalid_layer", path: configPath };
}

function mergeNetwork(layers: readonly MikotoPolicyConfig[]): MikotoPolicyDocument["network"] {
  const merged = { allowedDomains: [] as string[], deniedDomains: [] as string[] };
  for (const layer of layers) {
    for (const key of ["allowedDomains", "deniedDomains"] as const) {
      const next = layer.network?.[key];
      if (next !== undefined) merged[key] = mergePathArray(merged[key], next);
    }
  }
  return Object.freeze({
    allowedDomains: Object.freeze(merged.allowedDomains),
    deniedDomains: Object.freeze(merged.deniedDomains),
  });
}

function policyCacheKey(cwd: string, cwdTrusted: boolean): string {
  return `${cwd}\0${cwdTrusted ? "trusted" : "untrusted"}`;
}

function mergePolicyConfigs(
  layers: readonly MikotoPolicyConfig[],
  options: {
    readonly cwd: string;
    readonly homeDir?: string;
  },
) {
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
  return Object.freeze({
    denyRead: normalizeAndFreeze(merged.denyRead, options.cwd, homeDir),
    allowRead: normalizeAndFreeze(merged.allowRead, options.cwd, homeDir),
    allowWrite: normalizeAndFreeze(merged.allowWrite, options.cwd, homeDir),
    denyWrite: normalizeAndFreeze(merged.denyWrite, options.cwd, homeDir),
  });
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
