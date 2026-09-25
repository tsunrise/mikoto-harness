import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { safeName } from "./errors.ts";
import { encodeJson, MiB } from "./schema.ts";

// Compact rendering of untrusted tool metadata for the model. Signatures are
// a lossy view; `lossy` marks lines whose omitted detail likely matters, so
// the agent knows when to fetch the complete schema with describe.
const SUMMARY_MAX = 160;
const SIGNATURE_MAX = 400;
const LITERAL_MAX = 60;
const ENUM_MAX = 8;
const NESTING_MAX = 2;
// Parameter notes longer than this usually carry format rules or constraints.
const PARAMETER_NOTE_MAX = 150;
// Description prose left out of the summary beyond this is worth a look.
const REMAINDER_MAX = 600;

type Schema = Record<string, unknown>;
type State = { lossy: boolean };
const isSchema = (v: unknown): v is Schema => !!v && typeof v === "object" && !Array.isArray(v);

export const oneLine = (text: string, bound = 100_000) => safeName(text.replace(/\s+/g, " ").trim(), bound);
export function multiLine(text: string) {
  return text.replace(/\r\n?/g, "\n").split("\n").map(line => safeName(line.replace(/\t/g, "  "), 100_000)).join("\n").trim();
}

function literal(value: unknown, state: State) {
  const text = oneLine(JSON.stringify(value) ?? "null");
  if (text.length <= LITERAL_MAX) return text;
  state.lossy = true;
  return text.slice(0, LITERAL_MAX - 1) + "…";
}

const key = (name: string) => /^[\p{L}_$][\p{L}\p{N}_$-]*$/u.test(name) ? name : JSON.stringify(oneLine(name, 128));

function fields(schema: Schema, depth: number, state: State): string {
  if (!isSchema(schema.properties)) return "";
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties)
    .map(([name, value]) => `${key(name)}${required.has(name) ? "" : "?"}: ${type(value, depth, state)}`).join(", ");
}

function type(schema: unknown, depth: number, state: State): string {
  if (schema === undefined || schema === true) return "any";
  if (!isSchema(schema)) { state.lossy = true; return "any"; }
  if ("const" in schema) return literal(schema.const, state);
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.slice(0, ENUM_MAX).map(v => literal(v, state));
    if (schema.enum.length > ENUM_MAX) { state.lossy = true; values.push("…"); }
    return values.join("|") || "never";
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) return [...new Set(union.map(u => type(u, depth, state)))].join("|") || "any";
  if (schema.$ref !== undefined || schema.allOf !== undefined) { state.lossy = true; return "any"; }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return [...new Set(types.map(t => base(t, schema, depth, state)))].join("|");
}

function base(name: unknown, schema: Schema, depth: number, state: State): string {
  switch (name) {
    case "array": {
      const item = type(schema.items, depth, state);
      return (item.includes("|") ? `(${item})` : item) + "[]";
    }
    case "object":
    case undefined:
      if (isSchema(schema.properties) && Object.keys(schema.properties).length) {
        if (depth >= NESTING_MAX) { state.lossy = true; return "object"; }
        return `{${fields(schema, depth + 1, state)}}`;
      }
      return name === undefined ? "any" : "object";
    case "string": case "number": case "integer": case "boolean": case "null":
      return name;
    default:
      state.lossy = true;
      return "any";
  }
}

// Longest parameter description anywhere in the schema, bounded in depth.
function longestNote(schema: unknown): number {
  let longest = 0;
  const stack = [{ value: schema, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > 32 || !value || typeof value !== "object") continue;
    if (Array.isArray(value)) { for (const v of value) stack.push({ value: v, depth: depth + 1 }); continue; }
    const s = value as Schema;
    if (depth > 0 && typeof s.description === "string") longest = Math.max(longest, s.description.length);
    for (const child of Object.values(s)) if (child && typeof child === "object") stack.push({ value: child, depth: depth + 1 });
  }
  return longest;
}

// Abbreviations and initials whose period does not end a sentence.
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|incl|\p{L})\.$/iu;

function firstSentence(text: string) {
  for (const match of text.matchAll(/[.!?](?=\s|$)/g)) {
    const end = match.index + 1;
    if (match[0] === "." && ABBREVIATION.test(text.slice(Math.max(0, end - 8), end))) continue;
    return text.slice(0, end);
  }
  return text;
}

export function summarize(description: string | undefined) {
  const text = oneLine(description ?? "");
  let first = firstSentence(text);
  if (first.length > SUMMARY_MAX) first = first.slice(0, SUMMARY_MAX - 1) + "…";
  return { text: first, remainder: text.length - first.length };
}

type Metadata = Pick<Tool, "name" | "description" | "inputSchema">;

export function signature(tool: Metadata) {
  const state: State = { lossy: false };
  let text = `${oneLine(tool.name, 1024)}(${fields(tool.inputSchema as Schema, 0, state)})`;
  if (text.length > SIGNATURE_MAX) { state.lossy = true; text = text.slice(0, SIGNATURE_MAX - 2) + "…)"; }
  return { text, lossy: state.lossy };
}

export function line(tool: Metadata) {
  const sig = signature(tool);
  const summary = summarize(tool.description);
  const lossy = sig.lossy || summary.remainder > REMAINDER_MAX || longestNote(tool.inputSchema) > PARAMETER_NOTE_MAX;
  return `${sig.text}${summary.text ? ` — ${summary.text}` : ""}${lossy ? " [+]" : ""}`;
}

type Status = { server: string; state: string; catalog: string; reason?: string };
export type SearchView = {
  results: { query: string; tools: (Pick<Tool, "name" | "description" | "inputSchema"> & { server: string })[]; servers: Status[]; error?: { code: string } }[];
  callRouteBound: boolean;
};

export function renderSearch(view: SearchView): string {
  const out: string[] = [];
  const statuses = new Map<string, Status>();
  for (const r of view.results) for (const s of r.servers) if (s.state !== "ready") statuses.set(s.server, s);
  for (const s of statuses.values())
    out.push(`! ${oneLine(s.server, 128)}: ${s.state}${s.reason ? ` (${s.reason})` : ""}${s.catalog === "cached" ? ", cached catalog" : ""}`);
  if (!view.callRouteBound) out.push("! call route unbound: calls fail until Garden is loaded and Pi reloads");
  const seen = new Set<string>();
  let lossy = false;
  for (const r of view.results) {
    out.push(`# ${oneLine(r.query, 200)}`);
    if (r.error) out.push(`  ${r.error.code}`);
    else if (!r.tools.length) out.push("  (no matches)");
    let server: string | undefined;
    for (const tool of r.tools) {
      const s = tool.server;
      // Rank order is preserved; the server label repeats only when it changes.
      if (s !== server) { out.push(oneLine(s, 128)); server = s; }
      const id = JSON.stringify([s, tool.name]);
      if (seen.has(id)) { out.push(`  ${oneLine(tool.name, 1024)} (above)`); continue; }
      seen.add(id);
      const text = line(tool);
      lossy ||= text.endsWith(" [+]");
      out.push(`  ${text}`);
    }
  }
  if (lossy) out.push("[+] = signature omits details; use describe for the full schema.");
  return out.join("\n");
}

export type Described = { server: string; name: string; tool?: Tool; error?: string };

export function renderDescribe(items: Described[]): string {
  return items.map(({ server, name, tool, error }) => {
    const out = [`## ${oneLine(server, 128)} / ${oneLine(name, 1024)}`];
    if (!tool) { out.push(`error: ${error}`); return out.join("\n"); }
    if (tool.title) out.push(`title: ${oneLine(tool.title, 1024)}`);
    if (tool.description) out.push(multiLine(tool.description));
    if (tool.annotations) out.push(`annotations: ${encodeJson(tool.annotations, MiB)}`);
    const { $schema: _, ...schema } = tool.inputSchema as Schema;
    out.push(`inputSchema: ${encodeJson(schema, MiB)}`);
    return out.join("\n");
  }).join("\n\n");
}
