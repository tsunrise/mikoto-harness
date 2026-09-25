import { cleanup } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, stat, access, rename, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ArtifactStore, base64Bytes } from "../src/artifacts.ts";
import { png } from "./helpers.ts";

test("mixed binary content is privately materialized; actual Pi read emits image bytes", async t => {
  const life = new AbortController(), warnings: string[] = [];
  const store = new ArtifactStore(life.signal, r => warnings.push(r));
  cleanup(t, () => store.close());
  const original: CallToolResult = {
    isError: true, _meta: { preserved: "yes" }, structuredContent: { data: png },
    content: [
      { type: "text", text: png },
      { type: "image", data: png, mimeType: "application/wrong", annotations: { audience: ["assistant"] }, _meta: { note: 1 } },
      { type: "audio", data: "YWJj", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///../../not-a-filename", blob: png } },
      { type: "resource", resource: { uri: "text:test", text: "keep" } },
      { type: "resource_link", uri: "https://example.com", name: "link" },
    ],
  };
  const projected = await store.project(original, store.reserve(), life.signal);
  assert.ok(projected.rawResult);
  assert.deepEqual(JSON.parse(await readFile(projected.rawResult.path, "utf8")), original);
  assert.equal(projected.result.isError, true);
  assert.deepEqual(projected.result.structuredContent, original.structuredContent);
  assert.deepEqual(projected.result.content[0], original.content[0]);
  assert.deepEqual(projected.result.content[4], original.content[4]);
  const image = projected.result.content[1];
  assert.equal(image.type, "artifact_ref");
  if (image.type !== "artifact_ref") return;
  assert.equal(image.imageReadable, true);
  assert.equal(image.file.mimeType, "application/wrong");
  assert.equal(image.detectedImageMimeType, "image/png");
  assert.deepEqual(await readFile(image.file.path), Buffer.from(png, "base64"));
  assert.equal((await stat(image.file.path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(image.file.path))).mode & 0o777, 0o700);
  assert.equal((await stat(dirname(dirname(image.file.path)))).mode & 0o777, 0o700);
  const read = createReadTool(process.cwd(), { autoResizeImages: false });
  const output = await read.execute("image", { path: image.file.path }, life.signal);
  assert.ok(output.content.some(c => c.type === "image" && c.data === png));
  const audio = projected.result.content[2];
  assert.equal(audio.type, "artifact_ref");
  if (audio.type === "artifact_ref") {
    assert.equal(audio.imageReadable, false);
    assert.deepEqual(await readFile(audio.file.path), Buffer.from("abc"));
  }
  const embedded = projected.result.content[3];
  if (embedded.type === "artifact_ref") {
    assert.equal(embedded.file.mimeType, "application/octet-stream");
    assert.equal(embedded.imageReadable, true);
  } else assert.fail();
  await store.close();
  await assert.rejects(access(image.file.path));
  assert.deepEqual(warnings, []);
});

test("strict base64 accepts omitted padding and rejects malformed lengths/alphabet/pad bits", () => {
  for (const value of ["", "YQ", "YQ==", "YWI", "YWI=", "YWJj"])
    assert.equal(base64Bytes(value), Buffer.from(value, "base64").length);
  for (const value of ["A", "A===", "YW Jj", "YQ=", "YR==", "YWJ=", "____", "a=bc", "===="])
    assert.throws(() => base64Bytes(value), { code: "invalid_result" });
});

test("unknown/prototype-like MIME and hostile resource URI never choose filenames", async t => {
  const life = new AbortController(), store = new ArtifactStore(life.signal, () => {});
  cleanup(t, () => store.close());
  const projected = await store.project({ content: [{
    type: "resource", resource: { uri: "file:///../../escape", mimeType: "__proto__", blob: "YWJj" },
  }] }, store.reserve(), life.signal);
  const artifact = projected.result.content[0];
  assert.equal(artifact.type, "artifact_ref");
  if (artifact.type === "artifact_ref") {
    assert.ok(artifact.file.path.endsWith("/media-0.bin"));
    assert.equal(artifact.sourceUri, "file:///../../escape");
    assert.deepEqual(await readFile(artifact.file.path), Buffer.from("abc"));
  }
});

test("media/wire/block limits and reservation quota reject before publishing", async t => {
  const life = new AbortController();
  const store = new ArtifactStore(life.signal, () => {}, { wire: 1024, decoded: 3, blocks: 1, files: 4, bytes: 2054 });
  cleanup(t, () => store.close());
  const a = store.reserve(), b = store.reserve();
  assert.throws(() => store.reserve(), { code: "artifact_capacity" });
  a.finish(); b.finish();
  for (const content of [
    [{ type: "image", data: "YWJjZA==", mimeType: "image/png" }],
    [{ type: "image", data: "", mimeType: "x" }, { type: "audio", data: "", mimeType: "x" }],
    [{ type: "text", text: "x".repeat(1024) }],
  ]) {
    const reservation = store.reserve();
    try {
      await assert.rejects(store.project({ content } as CallToolResult, reservation, life.signal), { code: "result_too_large" });
    } finally { reservation.finish(); }
  }
  const nonmedia = store.reserve();
  await store.project({ content: [] }, nonmedia, life.signal);
  const one = store.reserve(), two = store.reserve();
  one.finish(); two.finish();
});

test("search reports share quota, are complete/readable, and are removed on close", async t => {
  const life = new AbortController();
  const store = new ArtifactStore(life.signal, () => {}, { bytes: 100, files: 1 });
  cleanup(t, () => store.close());
  const ref = await store.report('{"results":[]}', life.signal);
  assert.deepEqual(JSON.parse(await readFile(ref.path, "utf8")), { results: [] });
  assert.throws(() => store.report("{}", life.signal), { code: "artifact_capacity" });
  await store.close();
  await assert.rejects(access(ref.path));
});

test("aborted writers do not publish, and cleanup refuses a replaced runtime root", async t => {
  const life = new AbortController(), warnings: string[] = [];
  const store = new ArtifactStore(life.signal, r => warnings.push(r));
  cleanup(t, () => store.close());
  const abort = new AbortController(); abort.abort();
  await assert.rejects(store.report("{}", abort.signal));
  const ref = await store.report("{}", life.signal);
  const root = dirname(dirname(ref.path)), moved = root + "-moved-by-test";
  await rename(root, moved);
  await mkdir(root);
  cleanup(t, async () => { await rm(root, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true }); });
  await store.close();
  assert.ok(warnings.length);
  await access(root);
  await access(moved);
});
