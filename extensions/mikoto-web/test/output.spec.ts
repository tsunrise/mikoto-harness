import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { formatResult } from "../src/output.ts";

test("small results preserve structured evidence separately from model text", async () => {
  const input = { output: "https://example.org [wordlim: 200]\nL0: evidence", results: [{ ref_id: "turn0view0" }] };
  const result = await formatResult(input, new AbortController().signal);
  assert.equal(result.content[0].text, input.output);
  assert.deepEqual(result.structuredContent, { ...input, truncated: false });
});

test("large evidence is bounded for scripts and complete in a private artifact", async () => {
  for (const input of [
    { output: "x\n".repeat(3000), results: [] },
    { output: "é".repeat(600_000), results: [{ source: "https://example.org" }] },
    { output: "small text", results: [{ large: "x".repeat(2 * 1024 * 1024) }] },
  ]) {
    const result = await formatResult(input, new AbortController().signal);
    const path = result.structuredContent.full_response_path!;
    try {
      assert.ok(path);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), input);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
      assert.ok(Buffer.byteLength(result.structuredContent.output) <= 1024 * 1024);
      assert.ok(Buffer.byteLength(result.content[0].text) < 51 * 1024);
      assert.equal(result.structuredContent.truncated, Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024);
      if (result.structuredContent.truncated) assert.equal(result.structuredContent.results, null);
      else assert.deepEqual(result.structuredContent.results, input.results);
    } finally { await rm(dirname(path), { recursive: true, force: true }); }
  }
});

test("cancelled output does not produce a result", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(formatResult({ output: "test", results: null }, controller.signal), { name: "AbortError" });
});
