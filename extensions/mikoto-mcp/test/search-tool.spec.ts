import { cleanup } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile } from "node:fs/promises";
import { Fake, harness, setup, tool } from "./helpers.ts";

test("registered native tool batches duplicates/filters/limits and isolates unknown servers", async t => {
  const paths = await setup(t), fake = new Fake().ready([tool(), tool("second")]);
  const h = harness({ ...paths, adapter: () => fake, emit: () => {} });
  cleanup(t, () => h.stop());
  assert.equal(h.tools.size, 1);
  assert.equal(fake.listCalls, 0);
  await h.start();
  const output = await h.search({ queries: [
    { query: " browser ", limit: 1 }, { query: "browser", limit: 2 },
    { query: "browser", server: "missing" }, { query: "none" },
  ] });
  const details = output.details as any;
  assert.deepEqual(details.results.map((r: any) => r.index), [0, 1, 2, 3]);
  assert.deepEqual(details.results.map((r: any) => r.tools.length), [1, 2, 0, 0]);
  assert.equal(details.results[0].query, "browser");
  assert.equal(details.results[2].error.code, "unknown_server");
  assert.equal(details.callRouteBound, false);
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.listCalls, 1);
  assert.deepEqual(JSON.parse((output.content[0] as { text: string }).text), details);
  assert.deepEqual(h.bindings.map(b => b.path), ["/mcp/call"]);
});

test("invalid batches reject before waiting; missing config normally returns zero matches", async t => {
  const paths = await setup(t, {}), h = harness(paths);
  cleanup(t, () => h.stop());
  for (const params of [{ query: "old" }, { queries: [] }, { queries: [{ query: " " }] },
    { queries: [{ query: "x", extra: true }] }, { queries: [{ query: "x", limit: 21 }] },
    { queries: Array(9).fill({ query: "x" }) }])
    await assert.rejects(h.search(params), { code: "invalid_input" });
  await h.start();
  const output = await h.search({ queries: [{ query: "anything" }] });
  assert.equal((output.details as any).results[0].tools.length, 0);
});

test("oversized inline output spills complete schemas with ordered pointers; details remain small", async t => {
  const paths = await setup(t);
  const schema = { type: "object" as const, properties: { data: { description: "x".repeat(60_000), type: "string" } } };
  const h = harness({ ...paths, adapter: () => new Fake().ready([tool("large", { inputSchema: schema })]) });
  cleanup(t, () => h.stop());
  await h.start();
  const output = await h.search({ queries: [{ query: "browser" }, { query: "browser" }] });
  const details = output.details as any;
  assert.ok(details.fullResult.path);
  assert.ok(Buffer.byteLength(JSON.stringify(details)) < 48 * 1024);
  assert.equal(details.results[0].resultPointer, "/results/0");
  assert.equal(details.results[1].resultPointer, "/results/1");
  const full = JSON.parse(await readFile(details.fullResult.path, "utf8"));
  assert.deepEqual(full.results[0].tools[0].inputSchema, schema);
  h.tree();
  await access(details.fullResult.path);
  await h.start();
  await assert.rejects(access(details.fullResult.path));
});

test("report size/quota failures are safe tool failures without execution", async t => {
  for (const artifactLimits of [{ report: 100 }, { bytes: 10 }]) {
    const paths = await setup(t), fake = new Fake().ready([tool("large", { description: "browser " + "x".repeat(60_000) })]);
    const h = harness({ ...paths, artifactLimits, adapter: () => fake });
    cleanup(t, () => h.stop());
    await h.start();
    await assert.rejects(h.search({ queries: [{ query: "browser" }] }), { code: "report" in artifactLimits ? "search_result_too_large" : "artifact_capacity" });
    assert.equal(fake.calls.length, 0);
  }
});

test("native cancellation stops only that batch, not shared discovery", async t => {
  const paths = await setup(t), fake = new Fake(), h = harness({ ...paths, adapter: () => fake });
  cleanup(t, () => h.stop());
  await h.start();
  const abort = new AbortController();
  const searching = h.search({ queries: [{ query: "browser" }] }, abort.signal);
  const rejected = assert.rejects(searching, { name: "AbortError" });
  await fake.connected.promise; abort.abort(); await rejected;
  assert.equal(fake.closed, 0);
  fake.ready();
  assert.equal((await h.search({ queries: [{ query: "browser" }] })).content[0].type, "text");
});
