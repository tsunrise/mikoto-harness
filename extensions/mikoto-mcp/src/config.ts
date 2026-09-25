import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MiB, serverConfigSchema, serverName } from "./schema.ts";

export type TransportConfig =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> };
export type ConfigEntry = {
  server: string; config?: TransportConfig; fingerprint?: string; reason?: string;
  /** Tool names hidden from search, inspection and calls. Not part of the cache fingerprint. */
  disabledTools?: ReadonlySet<string>;
};
export type ConfigResult = { entries: ConfigEntry[]; unavailable: boolean };
export const defaultConfigPath = () => join(homedir(), ".pi", "agent", "mcp.json");
export const defaultCacheDir = () => join(homedir(), ".pi", "agent", "cache", "mikoto-mcp");
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");

export async function readBounded(path: string, max: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max) throw new Error("file_bound");
    // A growing file must not bypass the stat check.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, max + 1));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > max || used > stat.size) throw new Error("file_bound");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used));
  } finally { await file.close(); }
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, x]) => [k, stable(x)]));
  return v;
}
export const fingerprint = (config: TransportConfig) => digest(JSON.stringify(stable({ version: 1, config })));

export function normalizeConfig(
  input: unknown, configPath: string, cwd: string,
  env: NodeJS.ProcessEnv = process.env, inherited = getDefaultEnvironment(),
): ConfigResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_config");
  const servers = (input as Record<string, unknown>).mcpServers ?? {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)
    || Object.keys(servers).length > 64) throw new Error("invalid_config");
  const expand = (s: string) => {
    const expanded = s.replace(/\$\{([^}]*)\}/g, (_all, key: string) => {
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key) || env[key] === undefined) throw new Error("missing_env");
      return env[key]!;
    });
    if (expanded.length > 16384 || expanded.includes("\0")) throw new Error("invalid_string");
    return expanded;
  };
  const homePath = (s: string) => s.startsWith("~/") ? join(homedir(), s.slice(2)) : s;
  const entries = Object.entries(servers).map(([server, value]): ConfigEntry => {
    try {
      serverName.parse(server);
      const raw = serverConfigSchema.parse(value);
      if (raw.disabled) return { server, reason: "configured_disabled" };
      if ((raw.oauth != null && raw.oauth !== false) || (raw.auth != null && raw.auth !== false))
        return { server, reason: "unsupported_auth" };
      const command = raw.command === undefined ? undefined : expand(raw.command);
      const url = raw.url === undefined ? undefined : expand(raw.url);
      if ((command !== undefined) === (url !== undefined)) throw new Error("transport");
      const type = raw.type === "streamable-http" ? "http" : raw.type ?? (command !== undefined ? "stdio" : "http");
      let config: TransportConfig;
      if (type === "stdio") {
        if (!command?.trim() || url !== undefined || raw.headers !== undefined) throw new Error("transport");
        const effectiveCwd = raw.cwd === undefined ? resolve(cwd) : resolve(dirname(configPath), homePath(expand(raw.cwd)));
        const childEnv = Object.fromEntries(Object.entries({ ...inherited, ...Object.fromEntries(
          Object.entries(raw.env ?? {}).map(([k, v]) => [k, expand(v)]),
        ) }).filter(([k]) => !/^GARDEN_/i.test(k)));
        if (Object.keys(childEnv).some(k => k.includes("=") || k.includes("\0"))) throw new Error("env");
        const path = homePath(command);
        config = { type, command: isAbsolute(path) || !path.includes("/") ? path : resolve(effectiveCwd, path),
          args: (raw.args ?? []).map(expand), cwd: effectiveCwd, env: childEnv };
      } else {
        if (url === undefined || command !== undefined || raw.args !== undefined || raw.env !== undefined || raw.cwd !== undefined)
          throw new Error("transport");
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
          throw new Error("url");
        const headers: Record<string, string> = Object.create(null);
        for (const [key, value] of Object.entries(raw.headers ?? {})) {
          const k = key.toLowerCase();
          const v = expand(value);
          validateHeaderName(key); validateHeaderValue(key, v);
          if (/^(host|connection|content-length|transfer-encoding|te|trailer|upgrade|keep-alive|proxy-connection|accept|content-type)$/.test(k)
            || k.startsWith("mcp-") || Object.hasOwn(headers, k)) throw new Error("header");
          headers[k] = v;
        }
        config = { type, url: parsed.href, headers: { ...headers } };
      }
      return { server, config, fingerprint: fingerprint(config),
        ...(raw.disabledTools?.length ? { disabledTools: new Set(raw.disabledTools) } : {}) };
    } catch { return { server, reason: "invalid_config" }; }
  });
  return { entries, unavailable: false };
}

export async function loadConfig(path: string, cwd: string): Promise<ConfigResult> {
  try { return normalizeConfig(JSON.parse(await readBounded(path, MiB)), path, cwd); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], unavailable: false };
    return { entries: [], unavailable: true };
  }
}
