import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { Cache } from "../src/cache.ts";
import type { ServerSnapshot } from "../src/schema.ts";
import { directory, tool } from "./helpers.ts";

const snapshot = (tools = [tool()]): ServerSnapshot => ({
  version: 1, server: "../opaque", configFingerprint: "a".repeat(64), refreshedAt: new Date().toISOString(), tools,
});
test("atomic per-server snapshots are private, immutable, reusable, and include empty hits", async t => {
  const root = await directory(t), warnings: string[] = [];
  const cache = new Cache(root, (_, r) => warnings.push(r));
  const signal = new AbortController().signal;
  const original = snapshot();
  await cache.write(original, signal);
  const another = new Cache(root, (_, r) => warnings.push(r));
  const hit = await another.read("../opaque", "a".repeat(64));
  assert.deepEqual(hit, original);
  assert.ok(Object.isFrozen(hit?.tools[0].inputSchema));
  assert.equal((await stat(cache.path("../opaque"))).mode & 0o777, 0o600);
  assert.equal(await cache.read("../opaque", "b".repeat(64)), undefined);
  await cache.write(snapshot([]), signal);
  assert.deepEqual((await cache.read("../opaque", "a".repeat(64)))?.tools, []);
  assert.deepEqual(warnings, []);
  assert.equal((await readdir(root)).length, 1);
});

test("corruption, wrong identity/version, duplicates, controls, and oversized metadata are misses", async t => {
  const root = await directory(t), warnings: string[] = [];
  const cache = new Cache(root, (_, r) => warnings.push(r));
  const values = [
    "{", JSON.stringify({ ...snapshot(), version: 2 }), JSON.stringify({ ...snapshot(), server: "wrong" }),
    JSON.stringify(snapshot([tool(), tool()])), JSON.stringify(snapshot([tool("bad\nname")])),
    JSON.stringify(snapshot([tool("n", { description: "x".repeat(1024 * 1024) })])),
  ];
  for (const value of values) {
    await writeFile(cache.path("../opaque"), value);
    assert.equal(await cache.read("../opaque", "a".repeat(64)), undefined);
  }
  assert.equal(warnings.length, values.length);
});

test("concurrent writers publish whole files and aborted writers preserve last good cache", async t => {
  const root = await directory(t), cache = new Cache(root, () => {});
  const signal = new AbortController().signal;
  await Promise.all(Array.from({ length: 8 }, (_, i) => cache.write(snapshot([tool(String(i))]), signal)));
  assert.equal((await cache.read("../opaque", "a".repeat(64)))?.tools[0].name, "7");
  const before = await readFile(cache.path("../opaque"), "utf8");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cache.write(snapshot([]), controller.signal));
  assert.equal(await readFile(cache.path("../opaque"), "utf8"), before);
  assert.equal((await readdir(root)).length, 1);
});
