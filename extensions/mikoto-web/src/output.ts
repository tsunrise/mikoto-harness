import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SearchResult } from "./client.ts";

export const outputSchema = Type.Object({
  output: Type.String(),
  results: Type.Union([Type.Array(Type.Unknown()), Type.Null()]),
  truncated: Type.Boolean(),
  full_response_path: Type.Optional(Type.String()),
});
const SCRIPT_LIMIT = 1024 * 1024;

export async function formatResult(result: SearchResult, signal: AbortSignal) {
  const json = JSON.stringify(result);
  const preview = truncateHead(result.output);
  const scriptTruncated = Buffer.byteLength(json) > SCRIPT_LIMIT;
  let path: string | undefined;
  signal.throwIfAborted();
  if (preview.truncated || scriptTruncated) {
    const directory = await mkdtemp(join(tmpdir(), "mikoto-web-"));
    path = join(directory, "response.json");
    await writeFile(path, json, { mode: 0o600, signal });
  }
  signal.throwIfAborted();
  // A 100 MiB upstream response cannot safely be copied into a 256 MiB QuickJS
  // VM. Keep large data in a file, like Pi's bash/codemode output handling.
  const structuredContent = {
    output: scriptTruncated
      ? truncateHead(result.output, { maxBytes: SCRIPT_LIMIT, maxLines: Number.MAX_SAFE_INTEGER }).content
      : result.output,
    results: scriptTruncated ? null : result.results,
    truncated: scriptTruncated,
    ...(path ? { full_response_path: path } : {}),
  };
  return {
    content: [{
      type: "text" as const,
      text: preview.content + (path ? `\n\nComplete web response: ${path}` : ""),
    }],
    structuredContent,
    details: { truncated: preview.truncated || scriptTruncated, full_response_path: path },
  };
}
