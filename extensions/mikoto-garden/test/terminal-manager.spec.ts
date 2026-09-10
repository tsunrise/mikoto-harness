import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { prepareLaunch, shellQuote, type Launch } from "../src/launch.ts";
import { JOB_LIMITS } from "../src/protocol.ts";
import { formatResult } from "../src/tools.ts";
import { OutputStore } from "../src/executor/output-store.ts";
import { TerminalManager } from "../src/executor/terminal-manager.ts";
import type { Sandbox } from "../src/executor/sandbox.ts";

async function fixture(body: (h: {
  manager: TerminalManager; dir: string;
  spawn: (cmd: string, stdin?: boolean, tokens?: number) => ReturnType<TerminalManager["spawn"]>;
  poll: (id: number, tokens?: number, signal?: AbortSignal) => ReturnType<TerminalManager["input"]>;
}) => Promise<void>, warnings: string[] = []) {
  const parent = fileURLToPath(new URL("../test-runtime/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const dir = await realpath(await mkdtemp(join(parent, "retirement-")));
  // Exercise the real manager, pipes, and filesystem without nesting SRT.
  // Compiled-executor tests separately cover actual sandbox enforcement.
  const sandbox = {
    async checkReady() {},
    async wrap(launch: Launch) { return { argv: [launch.shell, "-c", launch.cmd], async cleanup() {} }; },
  } as unknown as Sandbox;
  const manager = new TerminalManager(sandbox, dir, dir, () => {});
  let request = 0;
  const signal = new AbortController().signal;
  try {
    await body({
      manager, dir,
      spawn: async (cmd, stdin = false, tokens = 10000) => manager.spawn({
        launch: await prepareLaunch({ cmd, stdin, shell: "sh", login: false }, dir, {}),
        wait: stdin ? 250 : 2000, tokens,
      }, ++request, signal),
      poll: (id, tokens = 10000, pollSignal = signal) => manager.input({
        id, operation: { kind: "poll", chars: "" }, wait: 1000, tokens,
      }, ++request, pollSignal, false),
    });
  } finally {
    assert.deepEqual((await manager.close()).warnings, warnings);
    assert.deepEqual(manager.list().jobs, []);
    await rm(dir, { recursive: true, force: true });
  }
}

test("completed initial results retire on ACK, not reservation; long sessions keep no completed cache", async () => {
  await fixture(async ({ manager, spawn, dir }) => {
    const ids = new Set<number>();
    for (let i = 0; i < JOB_LIMITS.outstanding + 3; i++) {
      const result = await spawn(i % 2 ? "printf observed" : "true");
      assert.equal(result.yielded, false);
      assert.equal(manager.list().jobs.length, 1);
      assert.ok(!ids.has(result.job.id));
      ids.add(result.job.id);
      manager.ack(result.job.id, result.chunk);
      assert.deepEqual(manager.list().jobs, []);
      assert.throws(() => manager.list(result.job.id), /Unknown or expired/);
    }
    assert.deepEqual(await readdir(dir), [], "unreferenced logs must not accumulate either");
  });
});

test("a live zero-unread job keeps its preview; a quiet uncollected exit keeps its row", async () => {
  await fixture(async ({ manager, spawn, poll }) => {
    const result = await spawn("printf preview; /bin/cat", true);
    assert.equal(result.output, "preview");
    manager.ack(result.job.id, result.chunk);
    const entry = manager.get(result.job.id);
    assert.equal(manager.list(result.job.id).tail, "preview");
    assert.equal(manager.list(result.job.id).jobs[0].unread, 0);
    await entry.process.write("", true, new AbortController().signal);
    await entry.process.finished;
    assert.equal(manager.list(result.job.id).jobs[0].state, "exited");
    assert.equal(manager.list(result.job.id).jobs[0].collected, false);
    const done = await poll(result.job.id);
    assert.equal(done.output, "");
    assert.equal(done.job.exit_code, 0);
    manager.ack(done.job.id, done.chunk);
    assert.deepEqual(manager.list().jobs, []);
  });
});

test("exit/output during a yielded handoff, previews, cancellation, and queued polls cannot retire unseen completion", async () => {
  await fixture(async ({ manager, spawn, poll }) => {
    for (const text of ["", "late output\n"]) {
      const live = await spawn("/bin/cat", true);
      const entry = manager.get(live.job.id);
      await entry.process.write(text, true, new AbortController().signal);
      await entry.process.finished;
      manager.ack(live.job.id, live.chunk);
      assert.equal(manager.list(live.job.id).jobs[0].collected, false);
      assert.equal(manager.list(live.job.id).jobs[0].unread, Buffer.byteLength(text));
      assert.equal(manager.list(live.job.id).tail, text);
      assert.equal(manager.list(live.job.id).jobs[0].unread, Buffer.byteLength(text));
      const cancelled = await poll(live.job.id);
      assert.equal(cancelled.output, text);
      await manager.cancel(cancelled.request!);
      assert.equal(manager.list(live.job.id).jobs[0].collected, false);
      const done = await poll(live.job.id);
      assert.equal(done.output, text);
      assert.throws(() => manager.ack(done.job.id, "not-the-reservation"), /Unknown output reservation/);
      const queued = assert.rejects(poll(live.job.id), /Unknown or expired/);
      manager.ack(done.job.id, done.chunk);
      await queued;
      assert.deepEqual(manager.list().jobs, []);
    }
    // Exercise the unread guard even if a future pipe implementation appends
    // after reserving a completed result. ACK commits only its own snapshot.
    const earlier = await spawn("printf earlier");
    manager.get(earlier.job.id).output.append(Buffer.from("later"), 0);
    manager.ack(earlier.job.id, earlier.chunk);
    assert.equal(manager.list(earlier.job.id).jobs[0].unread, 5);
    const later = await poll(earlier.job.id);
    assert.equal(later.output, "later");
    manager.ack(later.job.id, later.chunk);
    assert.deepEqual(manager.list().jobs, []);
  });
});

test("an aborted wait preserves the disclosed job and final output", async () => {
  await fixture(async ({ manager, spawn, poll }) => {
    const live = await spawn("/bin/cat", true);
    manager.ack(live.job.id, live.chunk);
    const controller = new AbortController();
    const cancelled = assert.rejects(poll(live.job.id, 1000, controller.signal));
    controller.abort();
    await cancelled;
    const entry = manager.get(live.job.id);
    await entry.process.write("after cancellation", true, new AbortController().signal);
    const done = await poll(live.job.id);
    assert.equal(done.output, "after cancellation");
    manager.ack(done.job.id, done.chunk);
    assert.deepEqual(manager.list().jobs, []);
  });
});

test("final delivery waits for inherited-pipe drain before it can retire the row", async () => {
  await fixture(async ({ manager, spawn, poll }) => {
    const childCode = 'process.once("message", () => setTimeout(() => { process.stdout.write("TAIL"); process.exit(0); }, 200));';
    const code = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
      process.stdin.resume();
      process.stdin.once("end", () => child.send("go", () => { child.disconnect(); process.exit(0); }));
    `;
    const live = await spawn(`${shellQuote(process.execPath)} -e ${shellQuote(code)}`, true);
    manager.ack(live.job.id, live.chunk);
    const entry = manager.get(live.job.id);
    const exited = new Promise<void>((resolve) => entry.process.child.once("exit", () => resolve()));
    await entry.process.write("", true, new AbortController().signal);
    const collecting = poll(live.job.id);
    await exited;
    assert.equal(manager.list().jobs.length, 1);
    const done = await collecting;
    assert.equal(done.output, "TAIL");
    assert.equal(done.yielded, false);
    manager.ack(done.job.id, done.chunk);
    assert.deepEqual(manager.list().jobs, []);
  });
});

test("retirement cleans tracked descendants that closed inherited pipes", async () => {
  await fixture(async ({ manager, spawn, poll }) => {
    const code = `
      const { spawn } = require("node:child_process");
      const child = spawn("/bin/sleep", ["20"], { stdio: "ignore" });
      console.log("DESC:" + child.pid);
      child.unref();
      process.stdin.resume();
      process.stdin.once("end", () => process.exit(0));
    `;
    const live = await spawn(`${shellQuote(process.execPath)} -e ${shellQuote(code)}`, true);
    manager.ack(live.job.id, live.chunk);
    // Keep the parent alive across two tracking intervals, so this exercises
    // known descendants rather than claiming containment of an escaped daemon.
    const running = await poll(live.job.id);
    manager.ack(running.job.id, running.chunk);
    const pid = Number((live.output + running.output).match(/DESC:(\d+)/)?.[1]);
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    process.kill(pid, 0);
    await manager.get(live.job.id).process.write("", true, new AbortController().signal);
    const done = await poll(live.job.id);
    assert.equal(done.job.cleanup, undefined);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    manager.ack(done.job.id, done.chunk);
    assert.deepEqual(manager.list().jobs, []);
  });
});

test("cleanup uncertainty survives retirement without retaining a terminal row", async () => {
  await fixture(async ({ manager, spawn }) => {
    const result = await spawn("printf observed");
    manager.get(result.job.id).process.cleanupWarning = "Descendant cleanup unconfirmed";
    manager.ack(result.job.id, result.chunk);
    assert.deepEqual(manager.list().jobs, []);
    assert.equal(await readFile(result.log, "utf8"), "observed");
    assert.deepEqual((await manager.close()).warnings, ["Retired job: Descendant cleanup unconfirmed"]);
  }, ["Retired job: Descendant cleanup unconfirmed"]);
});

test("uncollected completion is not silently evicted; collection frees bounded capacity", async () => {
  await fixture(async ({ manager, spawn, poll }) => {
    const ids: number[] = [];
    for (let i = 0; i < JOB_LIMITS.outstanding; i++) {
      const result = await spawn("printf unseen");
      ids.push(result.job.id);
      await manager.cancel(result.request!);
    }
    const oldest = manager.get(ids[0]);
    oldest.job.ended = Date.now() - 60 * 60_000;
    assert.equal(manager.list().jobs.length, JOB_LIMITS.outstanding);
    assert.equal(manager.list(ids[0]).tail, "unseen", "age does not authorize dropping unobserved data");
    await assert.rejects(
      spawn("true"),
      /outstanding-command capacity.*collect completed commands with write_stdin/i,
    );
    const done = await poll(ids[0]);
    assert.equal(done.output, "unseen");
    manager.ack(done.job.id, done.chunk);
    const next = await spawn("true");
    manager.ack(next.job.id, next.chunk);
    assert.equal(manager.list().jobs.length, JOB_LIMITS.outstanding - 1);
  });
});

test("retired jobs do not delete referenced omission logs, including header-only omissions", async () => {
  await fixture(async ({ manager, spawn, poll, dir }) => {
    const omitted = await spawn("printf saved", false, 0);
    assert.ok(omitted.omitted > 0);
    manager.ack(omitted.job.id, omitted.chunk);
    assert.equal(await readFile(omitted.log, "utf8"), "saved");
    const lines = await spawn(`${shellQuote(process.execPath)} -e 'process.stdout.write("x\\n".repeat(1998))'`);
    assert.equal(lines.omitted, 0);
    const formatted = formatResult(lines);
    assert.ok(formatted.details.omitted > 0);
    manager.ack(lines.job.id, lines.chunk, formatted.details.omitted > 0);
    assert.equal(await readFile(lines.log, "utf8"), "x\n".repeat(1998));
    const live = await spawn("printf earlier; /bin/cat", true, 0);
    manager.ack(live.job.id, live.chunk);
    await manager.get(live.job.id).process.write("", true, new AbortController().signal);
    const done = await poll(live.job.id);
    assert.equal(done.omitted, 0);
    manager.ack(done.job.id, done.chunk);
    assert.equal(await readFile(live.log, "utf8"), "earlier", "earlier acknowledged references remain valid");
    assert.deepEqual(manager.list().jobs, []);
    assert.equal((await readdir(dir)).length, 3);
    // Clearing in-memory terminal state is independent of the caller's log
    // directory. Executor generation teardown still owns its normal removal.
    await manager.close();
    assert.equal(await readFile(omitted.log, "utf8"), "saved");
  });
});

test("released omission reservations do not pin logs; ordinary collection refunds retained-byte quota", async () => {
  await fixture(async ({ manager, spawn, poll, dir }) => {
    const cancelled = await spawn("printf recovered", false, 0);
    await manager.cancel(cancelled.request!);
    const result = await poll(cancelled.job.id);
    assert.equal(result.output, "recovered");
    manager.ack(result.job.id, result.chunk);
    await assert.rejects(stat(result.log), { code: "ENOENT" });
    const quota = { bytes: 0 };
    const output = new OutputStore(join(dir, "quota.log"), quota);
    output.append(Buffer.from("fully observed"), 0);
    output.close();
    assert.equal(quota.bytes, 14);
    output.discardUnreferencedLog();
    assert.equal(quota.bytes, 14, "unread data prevents discarding the log");
    output.ack(output.reserve(1000).chunk);
    output.discardUnreferencedLog();
    assert.equal(quota.bytes, 0);
    output.discardUnreferencedLog();
    assert.equal(quota.bytes, 0, "repeated disposal cannot refund twice");
  });
});
