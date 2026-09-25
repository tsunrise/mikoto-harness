import assert from "node:assert/strict";
import { test } from "node:test";
import { Manager } from "../src/manager.ts";
import { cleanup, Fake, harness, setup, tool } from "./helpers.ts";
import { listing } from "../src/commands.ts";

test("commands notify once with sorted complete tool names, no model messages or custom UI", async t => {
  const paths = await setup(t, { z: { command: "z" }, A: { command: "A" } });
  const fake = () => new Fake().ready([tool("z"), tool("A"), tool("task", { execution: { taskSupport: "required" } })]);
  const h = harness({ ...paths, adapter: fake });
  cleanup(t, () => h.stop());
  await h.start();
  await h.search({ queries: [{ query: "browser" }] });
  assert.deepEqual([...h.commands.keys()], ["mcp", "mcp:verbose"]);
  await h.command("mcp");
  assert.equal(h.notices.length, 1);
  const count = h.notices[0].message;
  assert.ok(count.indexOf("A (3") < count.indexOf("z (3"));
  await h.command("mcp:verbose");
  assert.equal(h.notices.length, 2);
  const verbose = h.notices[1].message;
  assert.equal(verbose.split("\n").filter(line => line.startsWith("  ")).length, 6);
  assert.ok(verbose.indexOf("  A") < verbose.indexOf("  task"));
  assert.ok(verbose.indexOf("  task") < verbose.indexOf("  z"));
  assert.ok(!verbose.includes("pageUrl"));
  // The mock exposes only notify; any persistent UI or model-message API fails.
});

test("cached empty catalogs are marked; success/failure replace refreshing state", async t => {
  const paths = await setup(t, { empty: { command: "e" }, full: { command: "f" } });
  const first = new Manager(paths.root, () => {}, { ...paths, adapter: c => new Fake().ready(c.type === "stdio" && c.command === "e" ? [] : [tool("known")]) });
  await first.search([{ query: "anything", limit: 5 }]); await first.cache.settled(); await first.close();
  const e = new Fake(), f = new Fake();
  const manager = new Manager(paths.root, () => {}, { ...paths, adapter: c => c.type === "stdio" && c.command === "e" ? e : f });
  cleanup(t, () => manager.close());
  const servers = await manager.inspect();
  assert.match(listing(servers, false), /empty \(0 tools\*\)/);
  assert.match(listing(servers, false), /full \(1 tools\*\)/);
  assert.ok(!listing(servers, true).includes("*"));
  e.ready([]);
  f.handshake.resolve(true); f.page.reject(new Error("secret"));
  await Promise.all(servers.map(s => s.discovery.promise));
  const output = listing(await manager.inspect(), false);
  assert.ok(!output.includes("*"));
  assert.equal(manager.servers.get("empty")!.state, "ready");
  assert.equal(manager.servers.get("full")!.state, "disabled");
  assert.ok(listing(servers, true).includes("known"));
  assert.ok(!listing(servers, true).includes("secret"));
});

test("pending/no-catalog, skipped, empty, no-UI, usage, and current-context behavior", async t => {
  const paths = await setup(t, { waiting: { command: "x" }, skipped: { disabled: true }, "bad\u001b[31m": { command: "x" } });
  const fake = new Fake(), h = harness({ ...paths, adapter: () => fake });
  cleanup(t, () => h.stop());
  await h.start();
  const current: { message: string; type: string }[] = [];
  const context = { ...h.ctx, ui: { notify: (message: string, type: string) => current.push({ message, type }) } } as unknown as typeof h.ctx;
  await h.command("mcp", "", context);
  assert.equal(current.length, 1);
  assert.ok(current[0].message.includes("waiting (0"));
  assert.ok(current[0].message.includes("skipped (0"));
  assert.ok(!current[0].message.includes("\u001b"));
  assert.equal(fake.listCalls, 0);
  await h.command("mcp:verbose", "unexpected", context);
  assert.equal(current.length, 2);
  await h.command("mcp", "", { ...context, hasUI: false });
  assert.equal(current.length, 2);
  await h.stop();
  await h.command("mcp", "", context);
  assert.equal(current[2].type, "warning");
});

test("shutdown invalidates an inspection awaiting local bootstrap", async t => {
  const paths = await setup(t);
  const h = harness({ ...paths, adapter: () => new Fake() });
  await h.start();
  const command = h.command("mcp");
  const stop = h.stop();
  await Promise.all([command, stop]);
  assert.equal(h.notices.length, 0);
});
