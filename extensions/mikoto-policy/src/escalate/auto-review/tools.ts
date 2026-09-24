import { constants } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import type { Tool } from "@earendil-works/pi-ai";
import type { MikotoPolicyDocument } from "mikoto-types";
import { z } from "zod";
import { getCanonicalPath } from "../../canonical-path.ts";
import { evaluateRead } from "../../evaluate.ts";
import { resolveToolPath } from "../../utils.ts";
import { fragment } from "./context.ts";

const pathArg = z.string().min(1).refine((s) => !s.includes("\0"));
const count = (max: number) => z.number().int().min(1).max(max);
const schemas = {
  review_stat: z.strictObject({ path: pathArg }),
  review_read: z.strictObject({ path: pathArg, offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: count(65536).optional() }),
  review_list: z.strictObject({ path: pathArg, limit: count(200).optional() }),
  review_search: z.strictObject({ path: pathArg, query: z.string().min(1).max(16384), limit: count(100).optional() }),
};
const descriptions = {
  review_stat: "Read canonical path, type, size and mtime; missing metadata is explicit.",
  review_read: "Read regular UTF-8 file, byte offset (default 0), at most 65536 bytes; bounded output.",
  review_list: "List one directory without recursion or following child symlinks, at most 200 entries.",
  review_search: "Literal search in the first 65536 bytes of one regular UTF-8 file, at most 100 matches.",
};
export const investigationTools: Tool[] = Object.entries(schemas).map(([name, schema]) => ({
  name, description: descriptions[name as keyof typeof schemas],
  parameters: z.toJSONSchema(schema) as Tool["parameters"],
}));
const identity = (s: { dev: number; ino: number }) => `${s.dev}:${s.ino}`;

export class InvestigationTools {
  private readonly cwd: string;
  private readonly document: MikotoPolicyDocument;
  private readonly check: () => void;
  constructor(cwd: string, document: MikotoPolicyDocument, check: () => void) {
    this.cwd = cwd;
    this.document = document;
    this.check = check;
  }

  async dispatch(name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    const schema = schemas[name as keyof typeof schemas];
    if (!schema) throw new Error("tool_arguments");
    const parsed = schema.safeParse(args);
    if (!parsed.success) throw new Error("tool_arguments");
    const input = parsed.data as { path: string; offset?: number; limit?: number; query?: string };
    const check = () => { signal.throwIfAborted(); this.check(); };
    check();
    let handle: FileHandle | undefined;
    let canonical: string | undefined;
    try {
      const lexical = resolveToolPath(input.path, this.cwd);
      canonical = getCanonicalPath(lexical);
      const pinned = canonical;
      const tree = name === "review_list";
      if (!evaluateRead(this.document, canonical, tree ? "directory" : "file").allowed) {
        return { error: "permission_denied" };
      }
      check();
      const info = await lstat(canonical);
      const recheck = async () => {
        check();
        if (getCanonicalPath(lexical) !== pinned || getCanonicalPath(pinned) !== pinned ||
            identity(await lstat(pinned)) !== identity(info)) throw new Error("changed_identity");
        check();
      };
      await recheck();
      if (name === "review_stat") {
        return { path: canonical, type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "nonregular",
          size: info.size, mtime: info.mtimeMs };
      }
      if (tree) {
        if (!info.isDirectory()) return { error: "not_directory" };
        const directory = await opendir(canonical);
        try {
          await recheck();
          const entries: { name: string; type: string }[] = [];
          const limit = input.limit ?? 200;
          while (entries.length <= limit) {
            check();
            const child = await directory.read();
            if (!child) break;
            entries.push({ name: child.name, type: child.isSymbolicLink() ? "symlink" :
              child.isFile() ? "file" : child.isDirectory() ? "directory" : "nonregular" });
          }
          await recheck();
          return fragment({ path: canonical, entries: entries.slice(0, limit), truncated: entries.length > limit });
        } finally { await directory.close(); }
      }
      if (!info.isFile()) return { error: "not_regular_file" };
      await recheck();
      handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await handle.stat();
      if (!opened.isFile() || identity(opened) !== identity(info)) throw new Error("changed_identity");
      await recheck();
      const offset = input.offset ?? 0;
      const limit = name === "review_read" ? input.limit ?? 65536 : 65536;
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, offset);
      check();
      const incomplete = offset + bytesRead < opened.size;
      // Reject binary data rather than embedding it in evidence. Streaming
      // decoding retains a split trailing codepoint rather than declaring a
      // valid UTF-8 file binary or reading past the byte cap to finish it.
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
          .decode(buffer.subarray(0, bytesRead), { stream: incomplete });
      } catch { return { error: "not_utf8", incomplete: true }; }
      if (text.includes("\0")) return { error: "not_text" };
      if (name === "review_read") return fragment({
        path: canonical, offset, bytesRead, nextOffset: offset + Buffer.byteLength(text), incomplete, text,
      });
      const query = input.query!;
      const matches: { line: number; text: unknown }[] = [];
      const matchLimit = input.limit ?? 100;
      let more = false;
      for (const [index, line] of text.split("\n").entries()) {
        if (!line.includes(query)) continue;
        if (matches.length === matchLimit) { more = true; break; }
        matches.push({ line: index + 1, text: fragment(line) });
      }
      return fragment({ path: canonical, matches, bytesRead, incomplete: incomplete || more });
    } catch (error) {
      check();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { path: canonical, missing: true };
      if (code === "EACCES" || code === "EPERM") return { error: "permission_denied" };
      return { error: "access_failed_or_identity_changed" };
    } finally { await handle?.close(); }
  }
}
