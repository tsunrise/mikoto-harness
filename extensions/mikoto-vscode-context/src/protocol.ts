import path from "node:path";

// This small wire contract is mirrored in the Pi package, which is independently
// installable. The cross-package transport test checks that they still agree.
export const SOCKET_VARIABLE = "MIKOTO_VSCODE_CONTEXT_SOCKET";
export const REQUEST_BYTES = 1024;
export const RESPONSE_BYTES = 64 * 1024;
export const TEXT_BYTES = 32 * 1024;
export const MESSAGE_BYTES = 50 * 1024;
export const DEADLINE_MS = 500;
export type Position = { line: number; character: number };
export type Selection = { start: Position; end: Position; text: string };
export type Snapshot = {
  filePath: string;
  workspacePath: string;
  selections: Selection[];
  truncated: boolean;
};
export type Command = "ping" | "getContext";
export type Response =
  | { version: 1; status: "ok" | "empty" }
  | { version: 1; status: "error"; message: string }
  | { version: 1; status: "context"; context: Snapshot };

export function validPath(value: unknown, max = 4096): value is string {
  return typeof value === "string" && path.posix.isAbsolute(value) &&
    !value.includes("\0") && Buffer.byteLength(value) <= max;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed context");
  return value as Record<string, unknown>;
}

function position(value: unknown): Position {
  const p = object(value);
  for (const n of [p.line, p.character]) {
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 ||
      !Number.isSafeInteger(n + 1)) throw new Error("Malformed position");
  }
  return { line: p.line as number, character: p.character as number };
}

export function isCursor(s: Pick<Selection, "start" | "end">): boolean {
  return s.start.line === s.end.line && s.start.character === s.end.character;
}

export function validateSnapshot(value: unknown): Snapshot {
  const c = object(value);
  if (!validPath(c.filePath) || !validPath(c.workspacePath) ||
    typeof c.truncated !== "boolean" || !Array.isArray(c.selections) ||
    c.selections.length < 1 || c.selections.length > 32) throw new Error("Malformed context");
  let bytes = 0;
  const selections = c.selections.map((value): Selection => {
    const s = object(value);
    const start = position(s.start);
    const end = position(s.end);
    if (end.line < start.line || (end.line === start.line && end.character < start.character) ||
      typeof s.text !== "string") throw new Error("Malformed selection");
    const selection = { start, end, text: s.text };
    if ((isCursor(selection) && s.text !== "") ||
      (!isCursor(selection) && s.text === "" && !c.truncated)) throw new Error("Malformed selection");
    bytes += Buffer.byteLength(s.text);
    if (bytes > TEXT_BYTES) throw new Error("Oversized selection");
    return selection;
  });
  return { filePath: c.filePath, workspacePath: c.workspacePath, truncated: c.truncated, selections };
}

export function validateResponse(value: unknown, command: Command): Response {
  const r = object(value);
  if (r.version !== 1) throw new Error("Unsupported version");
  if (r.status === "error" && typeof r.message === "string") {
    // We never relay server-authored diagnostics to the terminal or model.
    return { version: 1, status: "error", message: "Editor capture failed" };
  }
  if (command === "ping" && r.status === "ok") return { version: 1, status: "ok" };
  if (command === "getContext") {
    if (r.status === "empty") return { version: 1, status: "empty" };
    if (r.status === "context") return { version: 1, status: "context", context: validateSnapshot(r.context) };
  }
  throw new Error("Unexpected response");
}

export function validateRequest(value: unknown): Command {
  const r = object(value);
  if (r.version !== 1 || (r.command !== "ping" && r.command !== "getContext")) {
    throw new Error("Unsupported request");
  }
  return r.command;
}

// Count bytes before decoding. A peer can split a UTF-8 character across any
// number of chunks, or send a huge chunk containing many lines.
export class JsonLine {
  private chunks: Buffer[] = [];
  private size = 0;
  private done = false;
  private readonly maxBytes: number;
  constructor(maxBytes: number) { this.maxBytes = maxBytes; }

  push(chunk: Buffer): { value: unknown } | undefined {
    if (this.done) return;
    const newline = chunk.indexOf(10);
    const part = newline < 0 ? chunk : chunk.subarray(0, newline + 1);
    this.size += part.length;
    if (this.size > this.maxBytes) throw new Error("Oversized frame");
    this.chunks.push(part);
    if (newline < 0) return;
    this.done = true;
    const bytes = Buffer.concat(this.chunks, this.size);
    this.chunks = [];
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  }
}

export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const cp of text) {
    bytes += Buffer.byteLength(cp);
    if (bytes > maxBytes) break;
    end += cp.length;
  }
  return text.slice(0, end);
}

export function fitSnapshot(
  source: Snapshot,
  serialize: (snapshot: Snapshot) => string,
  maxBytes: number,
): { snapshot: Snapshot; serialized: string } | undefined {
  const snapshot: Snapshot = {
    ...source,
    selections: source.selections.map(s => ({ ...s, start: { ...s.start }, end: { ...s.end } })),
  };
  const fits = () => Buffer.byteLength(serialize(snapshot)) <= maxBytes;
  if (!fits()) {
    snapshot.truncated = true;
    for (let i = snapshot.selections.length - 1; i >= 0 && !fits(); i--) {
      const s = snapshot.selections[i];
      const points = Array.from(s.text);
      s.text = "";
      if (!fits()) continue;
      let low = 0;
      let high = points.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        s.text = points.slice(0, mid).join("");
        if (fits()) low = mid;
        else high = mid - 1;
      }
      s.text = points.slice(0, low).join("");
    }
    while (!fits() && snapshot.selections.length > 1) snapshot.selections.pop();
  }
  return fits() ? { snapshot, serialized: serialize(snapshot) } : undefined;
}

export function contextResponse(snapshot: Snapshot): string {
  const fitted = fitSnapshot(snapshot,
    context => JSON.stringify({ version: 1, status: "context", context }) + "\n", RESPONSE_BYTES);
  return fitted?.serialized ?? JSON.stringify({ version: 1, status: "error", message: "Context too large" }) + "\n";
}
