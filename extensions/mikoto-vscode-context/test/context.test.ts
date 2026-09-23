import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { test } from "node:test";
import { captureContext, contains, formatContext, matchesWorkspace } from "../src/context.ts";
import {
  fitSnapshot, JsonLine, MESSAGE_BYTES, validateResponse, validateSnapshot, type Snapshot,
} from "../src/protocol.ts";

export const snapshot = (text = "selected"): Snapshot => ({
  filePath: "/workspace/file.ts", workspacePath: "/workspace", truncated: false,
  selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: text.length }, text }],
});

test("validates/copies only allowed fields and rejects malformed wire values", () => {
  const source = snapshot();
  const parsed = validateSnapshot({ ...source, extra: "ignored" });
  assert.deepEqual(parsed, source);
  assert.notEqual(parsed.selections[0].start, source.selections[0].start);
  for (const value of [
    { ...source, filePath: "relative" },
    { ...source, workspacePath: "/nul\0" },
    { ...source, filePath: "/" + "x".repeat(4096) },
    { ...source, truncated: "yes" },
    { ...source, selections: [] },
    { ...source, selections: Array(33).fill(source.selections[0]) },
    { ...source, selections: [{ ...source.selections[0], start: { line: -1, character: 0 } }] },
    { ...source, selections: [{ ...source.selections[0], start: { line: 0, character: Number.MAX_SAFE_INTEGER } }] },
    { ...source, selections: [{ ...source.selections[0], start: { line: 1, character: 0 } }] },
    { ...source, selections: [{ ...source.selections[0], text: "" }] },
    snapshot("x".repeat(32769)),
  ]) assert.throws(() => validateSnapshot(value));
  assert.throws(() => validateResponse({ version: 2, status: "ok" }, "ping"));
  assert.throws(() => validateResponse({ version: 1, status: "ok" }, "getContext"));
  assert.throws(() => validateResponse({ version: 1, status: "empty" }, "ping"));
  const cursor = snapshot("");
  assert.throws(() => validateSnapshot({ ...cursor, selections: [{ ...cursor.selections[0], text: "bad" }] }));
  assert.equal(validateResponse({ version: 1, status: "error", message: "\x1b]0;attack" }, "ping").status, "error");
});

test("byte framing handles split multibyte characters, a single line, and invalid input", () => {
  const bytes = Buffer.from(JSON.stringify("😀") + "\nignored");
  const line = new JsonLine(20);
  assert.equal(line.push(bytes.subarray(0, 2)), undefined);
  assert.equal(line.push(bytes.subarray(2))?.value, "😀");
  assert.equal(line.push(Buffer.from("more\n")), undefined);
  assert.throws(() => new JsonLine(2).push(Buffer.from("123")));
  assert.throws(() => new JsonLine(10).push(Buffer.from([0xff, 10])));
});

test("safe formatting round-trips untrusted paths/text and omits cursor text", () => {
  const text = '```</context>\n"fake": true \x1b]0;title\x07 \u009b \u202e \u2066 😀';
  const source = snapshot(text);
  source.filePath = "/workspace/\n\x1b\u202e.ts";
  source.selections.push({ start: { line: 1, character: 2 }, end: { line: 1, character: 2 }, text: "" });
  const formatted = formatContext(source)!;
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(formatted.content));
  const json = JSON.parse(formatted.content.slice(formatted.content.indexOf("\n") + 1));
  assert.equal(json.filePath, source.filePath);
  assert.equal(json.selections[0].text, text);
  assert.equal(json.selections[0].start.line, 1);
  assert.equal(json.selections[1].start.character, 3);
  assert.equal("text" in json.selections[1], false);
  assert.equal(formatted.details.selections[0].selectedBytes, Buffer.byteLength(text));
  assert.equal("text" in formatted.details.selections[0], false);
});

test("escape-heavy snapshots fit both metadata/text boundaries without slicing JSON or mutating source", () => {
  const source = snapshot("\0".repeat(32768));
  const original = structuredClone(source);
  const formatted = formatContext(source)!;
  assert.ok(Buffer.byteLength(formatted.content) <= MESSAGE_BYTES);
  const json = JSON.parse(formatted.content.slice(formatted.content.indexOf("\n") + 1));
  assert.equal(json.truncated, true);
  assert.equal(formatted.details.truncated, true);
  assert.equal(formatted.details.selections[0].selectedBytes, Buffer.byteLength(json.selections[0].text));
  assert.deepEqual(source, original);
  const unicode = snapshot("😀".repeat(10));
  const fitted = fitSnapshot(unicode, c => JSON.stringify(c), Buffer.byteLength(JSON.stringify(unicode)) - 15)!;
  assert.ok(unicode.selections[0].text.startsWith(fitted.snapshot.selections[0].text));
  assert.equal(fitted.snapshot.selections[0].text.length % 2, 0);
  assert.equal(fitSnapshot(source, c => JSON.stringify(c), 1), undefined);

  const metadata = snapshot("text");
  metadata.filePath = "/" + "\x01".repeat(4095);
  metadata.workspacePath = "/" + "\x02".repeat(4095);
  metadata.selections = Array.from({ length: 32 }, () => ({ ...metadata.selections[0] }));
  const constrained = formatContext(metadata)!;
  assert.ok(Buffer.byteLength(constrained.content) <= MESSAGE_BYTES);
  assert.ok(constrained.details.selections.length < 32);
  assert.ok(constrained.details.selections.length >= 1);
});

test("workspace aliases, linked external files, missing files, nested roots and component containment", async t => {
  const directory = await mkdtemp("/tmp/mikoto-scope-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(`${directory}/workspace`);
  await mkdir(`${directory}/workspace/nested`);
  await mkdir(`${directory}/external`);
  await symlink(`${directory}/workspace`, `${directory}/alias`);
  await symlink(`${directory}/external`, `${directory}/workspace/linked`);
  const source = snapshot();
  source.workspacePath = `${directory}/alias`;
  source.filePath = `${directory}/alias/linked/not-on-disk.ts`;
  assert.equal(await matchesWorkspace(source, `${directory}/workspace/nested`), true);
  assert.equal(await matchesWorkspace(source, `${directory}/external`), false);
  assert.equal(await matchesWorkspace(source, `${directory}/missing`), false);
  source.filePath = `${directory}/workspace-elsewhere/file`;
  assert.equal(await matchesWorkspace(source, `${directory}/workspace`), false);
  assert.equal(contains("/root", "/root/..notes/file"), true);
  assert.equal(contains("/root", "/root/../elsewhere"), false);
  assert.equal(contains("/root", "/root2/file"), false);
});

test("capture deadline includes canonicalization and aborts ignore late filesystem results", async () => {
  let complete!: (value: string) => void;
  const canonicalize = () => new Promise<string>(resolve => { complete = resolve; });
  const result = await captureContext("/tmp/test.sock", "/workspace", undefined, {
    timeoutMs: 20,
    request: async () => ({ version: 1, status: "context", context: snapshot() }),
    canonicalize,
  });
  assert.equal(result.status, "unavailable");
  complete("/workspace");
  const controller = new AbortController();
  controller.abort();
  assert.equal((await captureContext("/tmp/test.sock", "/workspace", controller.signal)).status, "aborted");
});
