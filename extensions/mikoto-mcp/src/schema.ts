import { z } from "zod";
import { ToolSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpError, type ErrorCode } from "./errors.ts";

export const MiB = 1024 * 1024;
export const identifier = (max: number) => z.string().min(1).max(max)
  .refine(s => s.trim().length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s));
export const serverName = identifier(128);
export const toolName = identifier(1024);
const configString = z.string().max(16 * 1024);
const stringMap = z.record(configString, configString).refine(v => Object.keys(v).length <= 128);
export const serverConfigSchema = z.strictObject({
  command: configString.optional(), args: z.array(configString).max(256).optional(),
  env: stringMap.optional(), cwd: configString.optional(),
  url: configString.optional(), headers: stringMap.optional(),
  type: z.enum(["stdio", "http", "streamable-http", "sse"]).optional(),
  disabled: z.boolean().optional(), oauth: z.unknown().optional(), auth: z.unknown().optional(),
  disabledTools: z.array(toolName).max(5000).optional(),
});

export function boundedArguments(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stack = [{ value, depth: 0 }];
  let count = 0;
  const seen = new Set<object>();
  while (stack.length) {
    const { value: item, depth } = stack.pop()!;
    if (++count > 4096 || depth > 32) return false;
    if (item === null || typeof item === "boolean" || typeof item === "string") continue;
    if (typeof item === "number" && Number.isFinite(item)) continue;
    if (typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype
      && Object.getPrototypeOf(item) !== null) return false;
    for (const child of Object.values(item)) stack.push({ value: child, depth: depth + 1 });
  }
  return true;
}

export const callSchema = z.strictObject({
  server: serverName, name: toolName,
  arguments: z.custom<Record<string, unknown>>(boundedArguments).default({}),
});
export type CallRequest = z.input<typeof callSchema>;
export const queriesSchema = z.strictObject({
  queries: z.array(z.strictObject({
    query: z.string().trim().min(1).max(2000),
    limit: z.number().int().min(1).max(20).default(5),
    server: serverName.optional(),
  })).min(1).max(8),
});
export type Query = z.infer<typeof queriesSchema>["queries"][number];

// Serialize in bounded chunks rather than allocating an oversized batch string.
// Network/config inputs are JSON; the ancestor set also protects injected callers.
export function encodeJson(value: unknown, max: number, code: ErrorCode = "result_too_large", pretty = false): string {
  type Work = { value: unknown; depth: number } | { text: string } | { exit: object };
  const stack: Work[] = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  const chunks: string[] = [];
  let bytes = 0;
  const append = (s: string) => {
    bytes += Buffer.byteLength(s);
    if (bytes > max) throw new McpError(code);
    chunks.push(s);
  };
  while (stack.length) {
    const work = stack.pop()!;
    if ("text" in work) { append(work.text); continue; }
    if ("exit" in work) { ancestors.delete(work.exit); continue; }
    const { value: v, depth } = work;
    if (depth > 128) throw new McpError(code);
    if (v === null || typeof v !== "object") {
      // Avoid escaping a single unbounded string before checking its lower bound.
      if (typeof v === "string" && Buffer.byteLength(v) > max - bytes) throw new McpError(code);
      const s = JSON.stringify(v);
      if (s === undefined) throw new McpError(code);
      append(s);
      continue;
    }
    if (ancestors.has(v)) throw new McpError(code);
    ancestors.add(v);
    stack.push({ exit: v });
    const array = Array.isArray(v);
    const entries = array ? v.map((x, i) => [String(i), x] as const)
      : Object.entries(v).filter(([, x]) => x !== undefined);
    const indent = pretty ? "\n" + "  ".repeat(depth) : "";
    stack.push({ text: (entries.length ? indent : "") + (array ? "]" : "}") });
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, child] = entries[i];
      if (i < entries.length - 1) stack.push({ text: "," });
      stack.push({ value: child, depth: depth + 1 });
      stack.push({ text: (pretty ? "\n" + "  ".repeat(depth + 1) : "") + (array ? "" : JSON.stringify(key) + (pretty ? ": " : ":")) });
    }
    append(array ? "[" : "{");
  }
  return chunks.join("");
}

export type ServerSnapshot = {
  version: 1; server: string; configFingerprint: string; refreshedAt: string; tools: Tool[];
};
export const snapshotSchema = z.strictObject({
  version: z.literal(1), server: serverName,
  configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  refreshedAt: z.iso.datetime(),
  tools: z.array(ToolSchema).max(5000),
});

export function validateTools(values: unknown[]): Tool[] {
  if (values.length > 5000) throw new McpError("result_too_large");
  const names = new Set<string>();
  return values.map(value => {
    encodeJson(value, MiB);
    const tool = ToolSchema.parse(value);
    toolName.parse(tool.name);
    if (names.has(tool.name)) throw new McpError("invalid_result");
    names.add(tool.name);
    return tool;
  });
}

export function freeze<T>(value: T): T {
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object" || Object.isFrozen(v)) continue;
    Object.freeze(v);
    for (const child of Object.values(v)) stack.push(child);
  }
  return value;
}
export const callable = (tool: Tool) => tool.execution?.taskSupport !== "required";
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
