import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ExecutorClient } from "../src/executor-client.ts";
import { CONTRACT, type Request } from "../src/protocol.ts";

test("normal executor close rejects outstanding requests and clears their deadlines", { timeout: 5000 }, async (t) => {
  // The real compiled child only handles shutdown; no SRT initialization,
  // listener, workload or process-table inspection is needed for this race.
  const client = new ExecutorClient("close-race", process.execPath, () => {}, () => {
    assert.fail("Normal close must not report an executor crash");
  });
  const child = (client as unknown as { child: ChildProcess }).child;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const send = child.send.bind(child);
  t.mock.method(child, "send", (...args: Parameters<ChildProcess["send"]>) => {
    // Hold one request without a reply while allowing real shutdown to finish.
    if ((args[0] as Request).method === "preflight") return true;
    return send(...args);
  });
  const pending = assert.rejects(client.request("preflight", {}, 1000), /executor closed/);
  try {
    assert.deepEqual(await client.close(), []);
    await pending;
    assert.equal(client.available, false);
    await assert.rejects(client.request("list", {}), /unavailable/);
  } finally {
    await client.close();
    await exited;
  }
});

test("an executor cannot initialize twice or retry a failed initialization", {
  skip: process.platform !== "darwin", timeout: 5000,
}, async () => {
  const parent = fileURLToPath(new URL("../test-runtime/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "init-once-"));
  const client = new ExecutorClient("init-once", process.execPath, () => {}, () => {});
  const init = {
    contract: CONTRACT,
    // Fail during filesystem preparation, before SRT can acquire any resources.
    runtimeParent: join(dir, "missing"),
    policy: {
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: false, allowUnixSockets: [] },
    },
  };
  try {
    const first = assert.rejects(client.request("init", init), /ENOENT/);
    const concurrent = assert.rejects(client.request("init", init), /already initialized/);
    await Promise.all([first, concurrent]);
    await assert.rejects(client.request("init", init), /already initialized/);
    assert.deepEqual(await client.close(), []);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
