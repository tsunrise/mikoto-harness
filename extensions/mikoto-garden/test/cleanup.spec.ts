import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ExecutorClient } from "../src/executor-client.ts";
import { prepareLaunch } from "../src/launch.ts";
import { CONTRACT } from "../src/protocol.ts";
import { cleanupOwnedRuntimeRoot } from "../src/executor/runtime-root.ts";

test("owned runtime cleanup is attempted despite earlier shutdown warnings", async () => {
  const parent = fileURLToPath(new URL("../test-runtime/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(join(parent, "runtime-root-")));
  const warnings = ["SRT cleanup unconfirmed"];
  try {
    await writeFile(join(root, "temporary"), "data");
    await cleanupOwnedRuntimeRoot(root, (await lstat(root)).ino, warnings);
    assert.deepEqual(warnings, ["SRT cleanup unconfirmed"]);
    await assert.rejects(lstat(root), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real initialization cancellation, parent-channel loss, and executor crash fail closed", {
  skip: process.platform !== "darwin", timeout: 30000,
}, async () => {
  const parent = fileURLToPath(new URL("../test-runtime/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const dir = await realpath(await mkdtemp(join(parent, "cleanup-")));
  const init = {
    contract: CONTRACT, runtimeParent: dir,
    policy: {
      filesystem: { denyRead: [], allowRead: [], allowWrite: [dir], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: ["*"], allowLocalBinding: false, allowUnixSockets: [] },
    },
  };
  const child = (client: ExecutorClient) => (client as unknown as { child: ChildProcess }).child;
  const clients: ExecutorClient[] = [];
  const client = (generation: string) => {
    const value = new ExecutorClient(generation, process.execPath, () => {}, () => {});
    clients.push(value);
    return value;
  };
  const waitFor = async (condition: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 8000;
    while (!await condition()) {
      assert.ok(Date.now() < deadline, "Cleanup deadline exceeded");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    const cancelled = client("cancel-init");
    const starting = assert.rejects(cancelled.request("init", init), /abort|closed|cancel/i);
    assert.deepEqual(await cancelled.close(), []);
    await starting;
    assert.deepEqual(await readdir(dir), []);

    const disconnected = client("disconnect");
    await disconnected.request("init", init);
    const job = await disconnected.request("spawn", {
      launch: await prepareLaunch({ cmd: "printf '%s\\n' $$; sleep 20", login: false }, dir, {}),
      wait: 250, tokens: 1000,
    });
    await disconnected.request("ack", { id: job.job.id, chunk: job.chunk });
    let pidOutput = job.output;
    await waitFor(async () => {
      if (pidOutput.trim()) return true;
      const poll = await disconnected.request("input", {
        id: job.job.id, operation: { kind: "poll", chars: "" }, wait: 1000, tokens: 1000,
      });
      pidOutput += poll.output;
      await disconnected.request("ack", { id: job.job.id, chunk: poll.chunk });
      return !!pidOutput.trim();
    });
    const fixturePid = Number(pidOutput.trim());
    assert.ok(Number.isSafeInteger(fixturePid) && fixturePid > 1);
    child(disconnected).disconnect();
    await waitFor(() => {
      try { process.kill(fixturePid, 0); return false; }
      catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); return true; }
    });
    await waitFor(async () => (await readdir(dir)).length === 0);
    assert.equal(disconnected.available, false);
    await assert.rejects(disconnected.request("list", {}), /unavailable/);

    const crashed = client("crash");
    await crashed.request("init", init);
    child(crashed).kill("SIGKILL");
    await waitFor(() => !crashed.available);
    await assert.rejects(crashed.request("list", {}), /unavailable/);
    assert.deepEqual(await crashed.close(), ["Executor cleanup unconfirmed"]);
    // SIGKILL cannot run the owner's cleanup. Do not call this a successful
    // cleanup result or claim adversarial descendant containment.
    assert.ok((await readdir(dir)).length > 0);
  } finally {
    await Promise.all(clients.map((value) => value.close()));
    await rm(dir, { recursive: true, force: true });
  }
});
