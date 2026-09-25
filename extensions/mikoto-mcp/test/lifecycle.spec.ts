import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { MikotoEventEmitter, MikotoGardenBindResult } from "mikoto-types";
import { bind } from "../src/bind.ts";
import { cleanup, Fake, harness, setup, png } from "./helpers.ts";
import { access, readFile } from "node:fs/promises";

test("factory is inert; repeated startup disposes route/clients; shutdown is idempotent", async t => {
  const paths = await setup(t), clients: Fake[] = [];
  const h = harness({ ...paths, adapter: () => { const f = new Fake().ready(); clients.push(f); return f; } });
  cleanup(t, () => h.stop());
  assert.equal(clients.length, 0);
  assert.equal(h.bindings.length, 0);
  await h.start();
  await h.search({ queries: [{ query: "browser" }] });
  await h.start();
  await h.search({ queries: [{ query: "browser" }] });
  assert.equal(h.disposed, 1);
  assert.ok(clients[0].closed > 0);
  await h.stop(); await h.stop();
  assert.equal(h.disposed, 2);
  assert.ok(clients[1].closed > 0);
});

test("shutdown racing session_start prevents a late runtime or binding", async t => {
  const paths = await setup(t), h = harness(paths);
  const start = h.start();
  await h.stop();
  await start;
  assert.equal(h.bindings.length, 0);
  await assert.rejects(h.search({ queries: [{ query: "x" }] }), { code: "config_unavailable" });
});

test("single call binding validates input, returns projected isError media, and preserves navigation artifacts", async t => {
  const paths = await setup(t), fake = new Fake().ready();
  fake.response = async () => ({ isError: true, content: [{ type: "image", data: png, mimeType: "image/png" }] });
  const h = harness({ ...paths, adapter: () => fake });
  cleanup(t, () => h.stop());
  await h.start();
  const binding = h.bindings[0];
  assert.equal(binding.path, "/mcp/call");
  assert.equal(binding.method, "POST");
  assert.equal((await binding.bodySchema.safeParseAsync({ server: "browser", name: "takeScreenshot", url: "bad" })).success, false);
  const parsed = await binding.bodySchema.safeParseAsync({ server: "browser", name: "takeScreenshot" });
  assert.ok(parsed.success);
  const response = await binding.handler({ body: parsed.data, method: "POST", path: "/mcp/call",
    headers: {}, signal: new AbortController().signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers?.["cache-control"], "no-store");
  const value = JSON.parse(response.body!);
  assert.equal(value.result.isError, true);
  assert.ok(!response.body!.includes(png));
  const path = value.result.content[0].file.path;
  assert.deepEqual(await readFile(path), Buffer.from(png, "base64"));
  h.tree();
  await access(path);
  await h.stop();
  await assert.rejects(access(path));
  const cache = await import("../src/cache.ts");
  const disk = new cache.Cache(paths.cacheDir, () => {});
  await access(disk.path("browser"));
});

test("binding duplicate/late/throwing acknowledgements dispose exactly their owned routes", async () => {
  const event = { owner: "test", method: "GET" as const, path: "/test" as const,
    bodySchema: z.undefined(), async handler() { return { status: 204 }; } };
  for (const scenario of ["duplicate", "late", "throw", "abort"] as const) {
    let callback!: (result: MikotoGardenBindResult) => void;
    let firstDisposed = 0, secondDisposed = 0;
    const controller = new AbortController();
    const first = { ok: true as const, bindingId: "one", dispose: () => { firstDisposed++; } };
    const second = { ok: true as const, bindingId: "two", dispose: () => { secondDisposed++; } };
    const events = { emit(_name: string, payload: any) {
      callback = payload.callback;
      if (scenario === "late") return;
      callback(first);
      if (scenario === "throw") throw new Error("secret");
      if (scenario === "abort") controller.abort();
      if (scenario === "duplicate") { callback(first); callback(second); }
    } } as MikotoEventEmitter;
    const dispose = await bind(events, event, controller.signal, 5);
    if (scenario === "duplicate") {
      assert.ok(dispose);
      assert.equal(firstDisposed, 0); assert.equal(secondDisposed, 1);
      callback(first); assert.equal(firstDisposed, 0); dispose();
    } else {
      assert.equal(dispose, undefined);
      if (scenario === "late") callback(first);
    }
    assert.equal(firstDisposed, 1);
  }
});

test("superseded runtime cannot warn or publish after a late discovery failure", async t => {
  const paths = await setup(t), first = new Fake();
  let count = 0;
  const h = harness({ ...paths, adapter: () => count++ ? new Fake().ready() : first });
  cleanup(t, () => h.stop());
  await h.start(); await first.connected.promise;
  const restart = h.start();
  first.handshake.reject(new Error("secret\u001b[31m"));
  await restart;
  await h.search({ queries: [{ query: "browser" }] });
  assert.equal(h.notices.length, 0);
});

test("headless warnings are one sanitized stderr line, without raw exception content", async t => {
  const paths = await setup(t), fake = new Fake();
  const h = harness({ ...paths, adapter: () => fake });
  cleanup(t, () => h.stop());
  h.ctx.hasUI = false;
  const lines: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await h.start(); await fake.connected.promise;
    fake.handshake.reject(new Error("credential-secret\u001b[31m"));
    await h.search({ queries: [{ query: "browser" }] });
  } finally { process.stderr.write = original; }
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("browser"));
  assert.ok(!lines[0].includes("credential-secret"));
  assert.ok(!lines[0].includes("\u001b"));
  assert.equal(h.notices.length, 0);
});
