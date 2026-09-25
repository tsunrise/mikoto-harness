import { cleanup } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, access } from "node:fs/promises";
import { Manager } from "../src/manager.ts";
import { McpError } from "../src/errors.ts";
import { Fake, deferred, result, setup, tool } from "./helpers.ts";

const query = [{ query: "browser", limit: 5 }];
const signal = () => new AbortController().signal;
async function seed(t: Parameters<typeof setup>[0], tools = [tool()]) {
  const paths = await setup(t);
  const first = new Manager(paths.root, () => {}, { ...paths, adapter: () => new Fake().ready(tools) });
  await first.search(query);
  await first.cache.settled();
  await first.close();
  return paths;
}

test("warm search precedes handshake; warm call waits for handshake but not listing", async t => {
  const paths = await seed(t), fake = new Fake();
  const manager = new Manager(paths.root, () => {}, { ...paths, adapter: () => fake });
  cleanup(t, () => manager.close());
  const found = await manager.search(query);
  assert.equal(found.results[0].tools[0].catalog, "cached");
  assert.equal(found.results[0].partial, true);
  const calling = manager.call({ server: "browser", name: "takeScreenshot" }, signal());
  await fake.connected.promise;
  assert.equal(fake.calls.length, 0);
  fake.handshake.resolve(true);
  assert.equal((await calling).catalog, "cached");
  assert.equal(fake.listCalls, 1);
  assert.equal(manager.servers.get("browser")!.state, "pending");
});

test("cold batch waits in parallel; filter isolates unrelated cold server", async t => {
  const paths = await setup(t, { a: { command: "a" }, b: { command: "b" } }), a = new Fake(), b = new Fake();
  const manager = new Manager(paths.root, () => {}, { ...paths, adapter: config => config.type === "stdio" && config.command === "a" ? a : b });
  cleanup(t, () => manager.close());
  const all = manager.search([{ query: "screenshot", limit: 5 }, { query: "b", limit: 1 }]);
  await Promise.all([a.connected.promise, b.connected.promise]);
  a.ready();
  const filtered = await manager.search([{ query: "a", server: "a", limit: 5 }]);
  assert.equal(filtered.results[0].tools.length, 1);
  b.ready([]);
  const response = await all;
  assert.equal(response.results.length, 2);
  assert.equal(response.results[0].servers.length, 2);
  assert.equal(response.results[0].partial, false);
  assert.equal(response.results[1].tools.length, 0);
});

test("fresh catalog atomically removes old names and resolves a new-name waiter", async t => {
  const paths = await seed(t), fake = new Fake();
  const manager = new Manager(paths.root, () => {}, { ...paths, adapter: () => fake });
  cleanup(t, () => manager.close());
  await manager.bootstrap;
  const added = manager.call({ server: "browser", name: "newTool" }, signal());
  fake.ready([tool("newTool")]);
  assert.equal((await added).catalog, "fresh");
  await assert.rejects(manager.call({ server: "browser", name: "takeScreenshot" }, signal()), { code: "unknown_tool" });
  assert.deepEqual(fake.calls.map(c => c.name), ["newTool"]);
  assert.equal((await manager.search(query)).results[0].tools[0].name, "newTool");
});

test("discovery failure disables cached tools once, keeps last-good disk, and isolates healthy peers", async t => {
  const paths = await seed(t), fake = new Fake(), warnings: string[] = [];
  const manager = new Manager(paths.root, (s, r) => warnings.push(`${s}:${r}`), { ...paths, adapter: () => fake });
  cleanup(t, () => manager.close());
  await manager.bootstrap;
  const before = await readFile(manager.cache.path("browser"), "utf8");
  fake.handshake.resolve(true);
  fake.page.reject(new Error("secret-token"));
  await manager.servers.get("browser")!.discovery.promise;
  const found = await manager.search(query);
  assert.equal(found.results[0].tools.length, 0);
  assert.equal(found.results[0].servers[0].state, "disabled");
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes("secret-token"));
  assert.equal(await readFile(manager.cache.path("browser"), "utf8"), before);
  assert.ok(manager.servers.get("browser")!.snapshot);
  await assert.rejects(manager.call({ server: "browser", name: "takeScreenshot" }, signal()), { code: "server_disabled" });
});

test("caller abort and tree navigation do not cancel shared discovery", async t => {
  const paths = await setup(t), fake = new Fake();
  const manager = new Manager(paths.root, () => {}, { ...paths, adapter: () => fake });
  cleanup(t, () => manager.close());
  const controller = new AbortController();
  const searching = manager.search(query, controller.signal);
  const rejected = assert.rejects(searching, { name: "AbortError" });
  await fake.connected.promise; controller.abort(); await rejected;
  manager.navigate();
  assert.equal(fake.closed, 0);
  fake.ready();
  assert.equal((await manager.search(query)).results[0].tools.length, 1);
});

test("batch deadline returns pending partials without giving every query a new budget", async t => {
  const paths = await setup(t), fake = new Fake();
  const manager = new Manager(paths.root, () => {}, { ...paths, adapter: () => fake, searchMs: 15 });
  cleanup(t, () => manager.close());
  const response = await manager.search([...query, ...query]);
  assert.equal(response.results.length, 2);
  assert.ok(response.results.every(r => r.partial && r.servers[0].state === "pending"));
  assert.equal(fake.closed, 0);
});

test("discovery deadline includes handshake and all pages; closes and settles empty/no-tools servers", async t => {
  const paths = await setup(t), fake = new Fake();
  const manager = new Manager(paths.root, () => {}, { ...paths, adapter: () => fake, discoveryMs: 15 });
  cleanup(t, () => manager.close());
  await manager.bootstrap;
  await manager.servers.get("browser")!.discovery.promise;
  assert.equal(manager.servers.get("browser")!.state, "disabled");
  assert.ok(fake.closed > 0);
  const none = new Fake(); none.handshake.resolve(false);
  const next = new Manager(paths.root, () => {}, { ...paths, adapter: () => none });
  cleanup(t, () => next.close());
  assert.equal((await next.search(query)).results[0].partial, false);
  assert.equal(none.listCalls, 0);
});

test("pagination rejects repeated cursors and cross-page duplicate names without partial publish", async t => {
  for (const duplicate of [true, false]) {
    const paths = await setup(t), fake = new Fake();
    fake.handshake.resolve(true);
    let pages = 0;
    fake.list = async () => ({ tools: [tool(duplicate ? "same" : String(++pages))], nextCursor: "repeat" });
    const manager = new Manager(paths.root, () => {}, { ...paths, adapter: () => fake });
    cleanup(t, () => manager.close());
    assert.equal((await manager.search(query)).results[0].servers[0].state, "disabled");
    assert.equal(manager.servers.get("browser")!.snapshot, undefined);
    await assert.rejects(access(manager.cache.path("browser")));
  }
});

test("calls preserve arguments, task rejection, MCP isError, concurrency and timeout outcomes", async t => {
  const paths = await setup(t), fake = new Fake().ready([tool(), tool("task", { execution: { taskSupport: "required" } })]);
  const manager = new Manager(paths.root, () => {}, { ...paths, adapter: () => fake, callMs: 50 });
  cleanup(t, () => manager.close());
  await manager.search(query);
  await assert.rejects(manager.call({ server: "missing", name: "x" }, signal()), { code: "unknown_server" });
  await assert.rejects(manager.call({ server: "browser", name: "task" }, signal()), { code: "unsupported_tool" });
  fake.response = async () => ({ ...result, isError: true });
  const args = { unknownProperty: [null, "exact", { x: 1 }] };
  assert.equal((await manager.call({ server: "browser", name: "takeScreenshot", arguments: args }, signal())).result.isError, true);
  assert.deepEqual(fake.calls[0].args, args);
  const gate = deferred<typeof result>();
  fake.response = () => gate.promise;
  const calls = Array.from({ length: 4 }, () => manager.call({ server: "browser", name: "takeScreenshot" }, signal()));
  const rejected = Promise.all(calls.map(call => assert.rejects(call, { code: "call_timeout", outcomeUnknown: true })));
  await assert.rejects(manager.call({ server: "browser", name: "takeScreenshot" }, signal()), { code: "busy" });
  await rejected;
  assert.equal(manager.servers.get("browser")!.state, "ready");
  gate.resolve(result);
  assert.equal(fake.calls.length, 5);
});

test("pre-dispatch artifact capacity and post-response delivery failures are distinct", async t => {
  const paths = await setup(t), fake = new Fake().ready();
  const manager = new Manager(paths.root, () => {}, { ...paths, adapter: () => fake, artifactLimits: { bytes: 10 } });
  cleanup(t, () => manager.close());
  await assert.rejects(manager.call({ server: "browser", name: "takeScreenshot" }, signal()), { code: "artifact_capacity" });
  assert.equal(fake.calls.length, 0);
  const good = new Fake().ready();
  const next = new Manager(paths.root, () => {}, { ...paths, adapter: () => good });
  cleanup(t, () => next.close());
  next.artifacts.project = async () => { throw new McpError("artifact_write_failed"); };
  await assert.rejects(next.call({ server: "browser", name: "takeScreenshot" }, signal()), error =>
    error instanceof McpError && error.executionCompleted === true && !error.outcomeUnknown);
  assert.equal(good.calls.length, 1);
});

test("cache write failure does not disable; removed/disabled/OAuth entries never start adapters", async t => {
  const paths = await setup(t, { browser: { command: "x" }, off: { disabled: true }, oauth: { auth: {} } });
  await writeFile(paths.cacheDir, "not a directory");
  let connected = 0;
  const manager = new Manager(paths.root, () => {}, { ...paths, adapter: () => { connected++; return new Fake().ready(); } });
  cleanup(t, () => manager.close());
  const found = await manager.search(query);
  assert.equal(connected, 1);
  assert.equal(found.results[0].tools.length, 1);
  assert.equal(found.results[0].servers.find(s => s.server === "browser")!.state, "ready");
});

test("invalid/oversized final results have unknown outcome, not delivery-completed flags", async t => {
  const paths = await setup(t), fake = new Fake().ready();
  const manager = new Manager(paths.root, () => {}, { ...paths, adapter: () => fake, artifactLimits: { wire: 1024 } });
  cleanup(t, () => manager.close());
  for (const content of [
    [{ type: "image", data: "not-base64", mimeType: "image/png" }],
    [{ type: "text", text: "x".repeat(1024) }],
    [{ type: "unknown" }],
  ]) {
    fake.response = async () => ({ content }) as typeof result;
    await assert.rejects(manager.call({ server: "browser", name: "takeScreenshot" }, signal()), error =>
      error instanceof McpError && error.outcomeUnknown === true && !error.executionCompleted);
  }
  assert.equal(fake.calls.length, 3);
  assert.equal(manager.servers.get("browser")!.state, "ready");
});

test("fatal transport failure interrupts dispatched calls once, without replay or affecting a peer", async t => {
  const paths = await setup(t, { a: { command: "a" }, b: { command: "b" } }), a = new Fake().ready(), b = new Fake().ready();
  let fatal!: (error: McpError) => void;
  const pending = deferred<typeof result>(); a.response = () => pending.promise;
  const manager = new Manager(paths.root, () => {}, { ...paths, adapter: (config, onFatal) => {
    if (config.type === "stdio" && config.command === "a") { fatal = onFatal; return a; }
    return b;
  } });
  cleanup(t, () => manager.close());
  await manager.search([{ query: "screenshot", limit: 5 }]);
  const calling = manager.call({ server: "a", name: "takeScreenshot" }, signal());
  const failed = assert.rejects(calling, { code: "transport_error", outcomeUnknown: true });
  await a.called.promise;
  fatal(new McpError("transport_error")); pending.reject(new Error("private transport error"));
  await failed;
  assert.equal(a.calls.length, 1);
  assert.equal((await manager.call({ server: "b", name: "takeScreenshot" }, signal())).result.isError, undefined);
  const found = await manager.search([{ query: "screenshot", limit: 5 }]);
  assert.deepEqual(found.results[0].tools.map(t => t.server), ["b"]);
});

test("valid pagination publishes once and optional tasks stay callable", async t => {
  const paths = await setup(t), fake = new Fake().ready();
  let pages = 0;
  fake.list = async () => ++pages === 1
    ? { tools: [tool("first")], nextCursor: "second-page" }
    : { tools: [tool("second", { execution: { taskSupport: "optional" } })] };
  const manager = new Manager(paths.root, () => {}, { ...paths, adapter: () => fake });
  cleanup(t, () => manager.close());
  assert.equal((await manager.search(query)).results[0].tools.length, 2);
  assert.equal(pages, 2);
  await manager.call({ server: "browser", name: "second" }, signal());
  assert.deepEqual(fake.calls.map(c => c.name), ["second"]);
});
