import { cleanup } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile } from "node:fs/promises";
import { Fake, harness, setup, tool } from "./helpers.ts";

// The describe block serializes the complete input schema on one line.
const schemaOf = (text: string) => JSON.parse(text.split("\n").find(l => l.startsWith("inputSchema: "))!.slice("inputSchema: ".length));

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
  const text = (output.content[0] as { text: string }).text;
  // Compact signatures replace schemas; a tool found again is not re-rendered.
  assert.equal(text.split("takeScreenshot(pageUrl?: string)").length - 1, 1);
  assert.ok(text.includes("second(pageUrl?: string)"));
  assert.ok(text.includes("unknown_server"));
  assert.ok(!text.includes("inputSchema"));
  assert.deepEqual(h.bindings.map(b => b.path), ["/mcp/call"]);
});

test("invalid batches reject before waiting; missing config normally returns zero matches", async t => {
  const paths = await setup(t, {}), h = harness(paths);
  cleanup(t, () => h.stop());
  for (const params of [{ query: "old" }, { queries: [] }, { queries: [{ query: " " }] },
    { queries: [{ query: "x", extra: true }] }, { queries: [{ query: "x", limit: 21 }] },
    { queries: Array(9).fill({ query: "x" }) }, {}, { describe: [] }, { describe: [{ server: "a" }] },
    { describe: [{ server: "a", name: "b", extra: 1 }] }, { describe: Array(9).fill({ server: "a", name: "b" }) }])
    await assert.rejects(h.search(params), { code: "invalid_input" });
  await h.start();
  const output = await h.search({ queries: [{ query: "anything" }] });
  assert.equal((output.details as any).results[0].tools.length, 0);
});

test("oversized describe output spills the complete text; details remain small", async t => {
  const paths = await setup(t);
  const note = "x".repeat(60_000);
  const schema = { type: "object" as const, properties: { data: { description: note, type: "string" } } };
  const h = harness({ ...paths, adapter: () => new Fake().ready([tool("large", { inputSchema: schema })]) });
  cleanup(t, () => h.stop());
  await h.start();
  const output = await h.search({ queries: [{ query: "browser" }], describe: [{ server: "browser", name: "large" }] });
  const details = output.details as any;
  assert.ok(details.fullResult.path);
  assert.ok(Buffer.byteLength(JSON.stringify(details)) < 48 * 1024);
  assert.ok(Buffer.byteLength((output.content[0] as { text: string }).text) < 1024);
  const full = await readFile(details.fullResult.path, "utf8");
  assert.deepEqual(schemaOf(full), schema);
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
    await assert.rejects(h.search({ describe: [{ server: "browser", name: "large" }] }), { code: "report" in artifactLimits ? "search_result_too_large" : "artifact_capacity" });
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

test("describe returns complete metadata for exact tools and reports unavailable ones", async t => {
  const paths = await setup(t, { browser: { command: "unused", disabledTools: ["hidden"] } });
  const schema = { $schema: "http://json-schema.org/draft-07/schema#", type: "object" as const,
    properties: { pageUrl: { type: "string", description: "Page address; must be absolute" } }, required: ["pageUrl"] };
  const description = "Take a screenshot.\nLonger guidance on a second line.";
  const fake = new Fake().ready([tool("takeScreenshot", { description, inputSchema: schema, annotations: { readOnlyHint: true } }),
    tool("hidden"), tool("task", { execution: { taskSupport: "required" } })]);
  const h = harness({ ...paths, adapter: () => fake });
  cleanup(t, () => h.stop());
  await h.start();
  const output = await h.search({ describe: [
    { server: "browser", name: "takeScreenshot" }, { server: "browser", name: "hidden" },
    { server: "browser", name: "task" }, { server: "browser", name: "missing" }, { server: "other", name: "x" },
  ] });
  const text = (output.content[0] as { text: string }).text;
  const { $schema: _, ...expected } = schema;
  assert.deepEqual(schemaOf(text), expected);
  assert.ok(text.includes(description));
  assert.ok(text.includes('"readOnlyHint":true'));
  assert.deepEqual((output.details as any).described.map((d: any) => d.error ?? "ok"),
    ["ok", "unknown_tool", "unsupported_tool", "unknown_tool", "unknown_server"]);
  assert.equal(fake.calls.length, 0);
});

test("one call can search and describe; describe waits for a cold catalog", async t => {
  const paths = await setup(t), fake = new Fake();
  const h = harness({ ...paths, adapter: () => fake });
  cleanup(t, () => h.stop());
  await h.start();
  const pending = h.search({ queries: [{ query: "browser" }], describe: [{ server: "browser", name: "takeScreenshot" }] });
  await fake.connected.promise;
  fake.ready();
  const output = await pending;
  const details = output.details as any;
  assert.deepEqual(details.results[0].tools, [{ server: "browser", name: "takeScreenshot" }]);
  assert.deepEqual(details.described, [{ server: "browser", name: "takeScreenshot" }]);
  const text = (output.content[0] as { text: string }).text;
  assert.ok(text.indexOf("takeScreenshot(pageUrl?: string)") < text.indexOf("inputSchema: "));
});
