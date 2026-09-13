import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { z } from "zod";
import type { MikotoEventEmitter, MikotoPolicyDocument, MikotoPolicyEscalateEvent } from "mikoto-types";
import { CapabilityRegistry } from "../src/capability-registry.ts";
import { CapabilityServer } from "../src/capability-server.ts";
import { renderGardenPrompt } from "../src/prompt.ts";
import { evaluateDestination } from "../src/executor/network-policy.ts";
import {
  safeEnvironment,
  prepareLaunch,
  shellQuote,
  withScratchEnvironment,
  type Launch,
} from "../src/launch.ts";
import { classifyInput, EXEC_DEFAULT_YIELD_MS, ExecInput, StdinInput, formatResult } from "../src/tools.ts";
import { requestEscalation } from "../src/permissions.ts";
import { OutputStore } from "../src/executor/output-store.ts";
import { ExecutorClient } from "../src/executor-client.ts";
import { CONTRACT } from "../src/protocol.ts";

const document: MikotoPolicyDocument = {
  filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
  network: { allowedDomains: ["example.com", "*.example.org:443"], deniedDomains: ["*:80", "private.example.org"] },
};
async function temporary<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const parent = fileURLToPath(new URL("../test-runtime/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const dir = await realpath(await mkdtemp(join(parent, "case-")));
  try { return await run(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
test("network precedence, malformed destinations, exact infrastructure grant and revocation", () => {
  const net = document.network;
  assert.equal(evaluateDestination(net, undefined, "example.com", 443), true);
  assert.equal(evaluateDestination(net, undefined, "example.com", 80), false);
  assert.equal(evaluateDestination(net, undefined, "x.example.org", 443), true);
  assert.equal(evaluateDestination(net, undefined, "example.org", 443), false);
  assert.equal(evaluateDestination(net, undefined, "private.example.org", 443), false);
  for (const host of ["127.1", "0177.0.0.1", "::1", "localhost.", "evil\0.example.com", "example.com/"]) {
    assert.equal(evaluateDestination(net, { port: 80 }, host, 80), false);
  }
  const denied = { allowedDomains: [], deniedDomains: ["*", "127.0.0.1", "127.0.0.1:80"] };
  assert.equal(evaluateDestination(denied, { port: 80 }, "127.0.0.1", 80), true);
  assert.equal(evaluateDestination(denied, { port: 80 }, "127.0.0.1", 81), false);
  assert.equal(evaluateDestination(denied, undefined, "127.0.0.1", 80), false);
  assert.equal(evaluateDestination(denied, { port: 80 }, "127.0.0.1", 80, false), false);
});
test("compiled filesystem enforcement preserves alternating read rules and write-deny precedence", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  await temporary(async (dir) => {
    const denied = join(dir, "denied");
    const allowed = join(denied, "allowed");
    const nested = join(allowed, "nested");
    const reallowed = join(nested, "reallowed");
    for (const path of [denied, allowed, nested, reallowed]) await mkdir(path);
    for (const path of [denied, allowed, nested, reallowed]) await writeFile(join(path, "file"), "fixture");
    await symlink(nested, join(dir, "alias"));
    const client = new ExecutorClient("filesystem-test", process.execPath, () => {}, () => {});
    try {
      await client.request("init", {
        contract: CONTRACT, runtimeParent: dir,
        policy: { network: { allowedDomains: [], deniedDomains: ["*"] }, filesystem: {
          denyRead: [denied, nested], allowRead: [allowed, reallowed],
          allowWrite: [dir, reallowed], denyWrite: [nested],
        } },
      }, 20000);
      const run = async (cmd: string) => {
        const result = await client.request("spawn", {
          launch: await prepareLaunch({ cmd, login: false }, dir, {}), wait: 1000, tokens: 1000,
        });
        await client.request("ack", { id: result.job.id, chunk: result.chunk });
        return result;
      };
      assert.notEqual((await run(`cat ${shellQuote(join(denied, "file"))}`)).job.exit_code, 0);
      assert.equal((await run(`cat ${shellQuote(join(allowed, "file"))}`)).output, "fixture");
      assert.notEqual((await run(`cat ${shellQuote(join(dir, "alias/file"))}`)).job.exit_code, 0);
      assert.equal((await run(`cat ${shellQuote(join(reallowed, "file"))}`)).output, "fixture");
      assert.notEqual((await run(`printf bad >> ${shellQuote(join(reallowed, "file"))}`)).job.exit_code, 0);
      assert.notEqual((await run(`mv ${shellQuote(nested)} ${shellQuote(join(dir, "moved"))}`)).job.exit_code, 0);
      const log = (await run("echo log-marker")).log;
      assert.notEqual((await run(`cat ${shellQuote(log)}`)).job.exit_code, 0);
      assert.notEqual((await run(`printf bad >> ${shellQuote(log)}`)).job.exit_code, 0);
      const scratch = await run('printf scratch > "$TMPDIR/file"; cat "$TMPDIR/file"');
      assert.equal(scratch.output, "scratch");
    } finally { assert.deepEqual(await client.close(), []); }
  });
});
test("strict post-hook inputs, pipe classifications, environment and deterministic prompt", () => {
  assert.equal(ExecInput.safeParse({ cmd: "true", tty: true }).success, false);
  assert.equal(ExecInput.safeParse({ cmd: "true", sandbox_permissions: "require_escalated" }).success, false);
  assert.equal(ExecInput.safeParse({ cmd: "true", justification: "unused" }).success, false);
  assert.equal(ExecInput.safeParse({ cmd: "\ud800" }).success, false);
  assert.equal(StdinInput.safeParse({ session_id: 1, chars: "\udc00" }).success, false);
  for (const value of [-1, 1.5, Infinity, NaN]) assert.equal(StdinInput.safeParse({ session_id: 1, yield_time_ms: value }).success, false);
  assert.equal(classifyInput({ session_id: 1, chars: "\u0003" }).kind, "interrupt");
  assert.equal(classifyInput({ session_id: 1, chars: "\u0004" }).kind, "write");
  assert.equal(classifyInput({ session_id: 1, close_stdin: true }).kind, "eof");
  assert.throws(() => classifyInput({ session_id: 1, chars: "\u0003", close_stdin: true }));
  assert.equal(EXEC_DEFAULT_YIELD_MS, 10_000);
  const env = safeEnvironment({
    NODE_OPTIONS: "--import malicious", HTTPS_PROXY: "http://bad", GARDEN_TOKEN: "stale",
    GARDEN_SERVER: "stale", PI_SESSION_ID: "stale", OPENAI_API_KEY: "secret", BASH_ENV: "bad",
    PATH: ":relative:/usr/bin", LANG: "en_US.UTF-8",
  }, { PI_SESSION_ID: "fresh" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.PI_SESSION_ID, "fresh");
  for (const key of ["GARDEN_TOKEN", "GARDEN_SERVER", "NODE_OPTIONS", "HTTPS_PROXY", "BASH_ENV", "OPENAI_API_KEY"]) assert.equal(env[key], undefined);
  const prompt = renderGardenPrompt(document);
  assert.equal(prompt, renderGardenPrompt({ ...document, network: {
    allowedDomains: [...document.network.allowedDomains].reverse(), deniedDomains: [...document.network.deniedDomains].reverse(),
  } }));
  assert.equal(prompt, renderGardenPrompt({ ...document, network: { allowedDomains: [], deniedDomains: ["*"] } }),
    "Policy, not Garden, owns the effective network snapshot");
  assert.notEqual(renderGardenPrompt(), prompt);
  assert.deepEqual(document.network.allowedDomains, ["example.com", "*.example.org:443"]);
});
test("scratch environment is shared by sandboxed and elevated launch modes", () => {
  const base = {
    cmd: "true",
    cwd: "/workspace",
    shell: "/bin/sh",
    login: false,
    stdin: false,
    env: Object.freeze({ PATH: "/usr/bin" }),
    cwdIdentity: "cwd",
    shellIdentity: "shell",
    capabilities: false,
  };
  for (const mode of ["sandboxed", "unsandboxed"] as const) {
    const launch: Launch = Object.freeze({ ...base, mode });
    const prepared = withScratchEnvironment(launch, "/runtime/scratch");
    assert.equal(prepared.env.TMPDIR, "/runtime/scratch");
    assert.equal(prepared.mode, mode);
    assert.equal(launch.env.TMPDIR, undefined);
  }
});
test("approval callback-then-throw, rejection, missing receiver and cancellation fail closed", async () => {
  const bus = new EventEmitter();
  const events: MikotoEventEmitter = { emit(name: string, data: unknown) { bus.emit(name, data); } };
  const controller = new AbortController();
  const request = { requestId: "one", source: "test", verb: "test", subject: "exact", why: "test", signal: controller.signal };
  assert.deepEqual(await requestEscalation(events, request), { decision: "reject", cause: "unavailable" });
  bus.on("mikoto-policy:escalate", (event: MikotoPolicyEscalateEvent) => {
    assert.equal(event.claim(), true);
    void event.callback({ decision: "approve" });
    throw new Error("dispatch failed");
  });
  assert.deepEqual(await requestEscalation(events, request), { decision: "reject", cause: "error" });
  bus.removeAllListeners();
  bus.on("mikoto-policy:escalate", (event: MikotoPolicyEscalateEvent) => event.claim());
  const pending = requestEscalation(events, request);
  controller.abort();
  assert.deepEqual(await pending, { decision: "reject", cause: "cancelled" });
});
test("authenticated HTTP schema outputs, errors, routing and disposal", async () => {
  const registry = new CapabilityRegistry();
  let calls = 0;
  const binding = registry.bind({
    owner: "test", method: "POST", path: "/example",
    bodySchema: z.strictObject({ count: z.number().default(2) }).transform(({ count }) => `parsed:${count}`),
    async handler({ body }) { calls++; return { status: 200, body: body.toUpperCase() }; },
  });
  assert.ok(binding.ok);
  assert.equal(registry.bind({
    owner: "duplicate", method: "POST", path: "/example", bodySchema: z.any(),
    async handler() { return { status: 204 }; },
  }).ok, false);
  registry.bind({
    owner: "test", method: "GET", path: "/get", bodySchema: z.undefined(),
    async handler({ body }) { assert.equal(body, undefined); return { status: 200, body: "get" }; },
  });
  const server = await CapabilityServer.start(registry, () => assert.fail("unexpected server failure"));
  assert.ok(server?.endpoint);
  const endpoint = server.endpoint;
  const auth = { authorization: `Bearer ${endpoint.token}` };
  try {
    const url = `${endpoint.url}/example`;
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: auth, body: "{}" })).status, 415);
    assert.equal((await fetch(url, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{" })).status, 400);
    assert.equal(calls, 0);
    const result = await fetch(url, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    assert.equal(await result.text(), "PARSED:2");
    assert.equal(calls, 1);
    assert.equal((await fetch(`${endpoint.url}/get`, { headers: auth })).status, 200);
    assert.equal((await fetch(url, { headers: { ...auth, origin: "https://browser.invalid" } })).status, 400);
    if (binding.ok) { binding.dispose(); binding.dispose(); }
    assert.equal((await fetch(url, { method: "POST", headers: auth })).status, 404);
  } finally { await server.close(); registry.close(); }
});
test("output split UTF-8, reservation cancellation, floods and full response budget", async () => {
  await temporary(async (dir) => {
    const output = new OutputStore(join(dir, "output.log"), { bytes: 0 });
    const bytes = Buffer.from("hello 😀\n\"quote\"\\backslash");
    output.append(bytes.subarray(0, 8), 0); output.append(bytes.subarray(8), 0);
    const first = output.reserve(10000);
    assert.equal(first.output, bytes.toString());
    output.release();
    assert.equal(output.reserve(10000).output, first.output);
    output.release();
    const accepted = output.reserve(10000);
    output.ack(accepted.chunk);
    assert.equal(output.unread, 0);
    assert.equal(output.preview(), bytes.toString(), "local previews survive collection");
    output.append(Buffer.from("😀".repeat(2000)), 1);
    assert.ok(Buffer.byteLength(output.preview()) <= 4096);
    assert.doesNotMatch(output.preview(), /\ufffd/);
    output.append(Buffer.alloc(2 * 1024 * 1024, "x"), 1);
    const result = output.reserve(1000000);
    assert.ok(result.omitted > 0);
    assert.ok(Buffer.byteLength(result.output) <= 44 * 1024);
    const response = formatResult({
      ...result, yielded: false, capabilities: false, wall_ms: 100,
      job: { id: 1, mode: "sandboxed", state: "exited", cmd: "test", cwd: dir, started: 0,
        stdinOpen: false, disclosed: true, unread: 0, exit_code: null, exit_signal: "SIGTERM" },
    });
    assert.match(response.content[0].text, /Process terminated by signal SIGTERM/);
    assert.match(response.content[0].text, /Capabilities: unavailable/);
    assert.ok(Buffer.byteLength(response.content[0].text) <= 50 * 1024);
    assert.ok(!response.content[0].text.startsWith("{"));
    const manyLines = formatResult({ ...response.details, output: "x\n".repeat(2000), omitted: 0 });
    assert.ok(manyLines.content[0].text.split("\n").length <= 2000);
    assert.ok(manyLines.details.omitted > 0);
    assert.match(manyLines.content[0].text, /Saved log:/);
    output.ack(result.chunk); output.close();
    assert.equal(output.unread, 0);
    assert.equal(output.preview(), "x".repeat(4096));
  });
});
test("real compiled macOS executor: pipes, output, authorization, cancellation, revoke", { skip: process.platform !== "darwin", timeout: 60000 }, async () => {
  await temporary(async (dir) => {
    const client = new ExecutorClient("integration-test", process.execPath, () => {}, () => {});
    const launch = async (cmd: string, stdin = false, mode = "use_default") => prepareLaunch({
      cmd, stdin, login: false, sandbox_permissions: mode,
    }, dir, {});
    const collect = async (result: Awaited<ReturnType<typeof client.request<"spawn">>>) => {
      await client.request("ack", { id: result.job.id, chunk: result.chunk });
      return result;
    };
    try {
      await client.request("init", { contract: CONTRACT, policy: { ...document,
        filesystem: { ...document.filesystem, allowWrite: [dir] } }, runtimeParent: dir }, 20000);
      const immediate = await collect(await client.request("spawn", {
        launch: await launch("printf 'hello\\n\"quote\"\\\\backslash'"), wait: 1000, tokens: 10000,
      }));
      assert.equal(immediate.job.exit_code, 0);
      assert.equal(immediate.output, 'hello\n"quote"\\backslash');
      const live = await collect(await client.request("spawn", { launch: await launch("cat", true), wait: 250, tokens: 10000 }));
      assert.ok(live.yielded);
      const done = await collect(await client.request("input", {
        id: live.job.id, operation: { kind: "write-close", chars: "line\n" }, wait: 1000, tokens: 10000,
      }));
      assert.equal(done.output, "line\n");
      assert.equal(done.job.exit_code, 0);
      assert.equal((await collect(await client.request("spawn", { launch: await launch("cat"), wait: 1000, tokens: 0 }))).job.exit_code, 0);
      assert.equal((await collect(await client.request("spawn", { launch: await launch("exit 7"), wait: 1000, tokens: 0 }))).job.exit_code, 7);
      const bytes = await collect(await client.request("spawn", { launch: await launch("od -An -t x1", true), wait: 250, tokens: 1000 }));
      const byteResult = await collect(await client.request("input", {
        id: bytes.job.id, operation: { kind: "write-close", chars: "a\u0003b\u0004" }, wait: 1000, tokens: 1000,
      }));
      assert.match(byteResult.output, /61\s+03\s+62\s+04/);
      for (const stdin of [false, true]) {
        const interrupted = await collect(await client.request("spawn", { launch: await launch("sleep 20", stdin), wait: 250, tokens: 0 }));
        const end = await collect(await client.request("input", {
          id: interrupted.job.id, operation: { kind: "interrupt", chars: "\u0003" }, wait: 1000, tokens: 0,
        }));
        assert.equal(end.job.exit_signal, "SIGINT");
        assert.equal(end.job.exit_code, null);
      }
      await assert.rejects(client.request("spawn", {
        launch: await launch("true", false, "require_escalated"), wait: 250, tokens: 0,
      }), /authorization/);
      const elevated = await collect(await client.request("spawn", {
        launch: await launch("cat", true, "require_escalated"), wait: 250, tokens: 1000,
      }, 10000, undefined, true));
      await assert.rejects(client.request("input", {
        id: elevated.job.id, operation: { kind: "eof", chars: "" }, wait: 250, tokens: 0,
      }), /authorization/);
      await collect(await client.request("input", {
        id: elevated.job.id, operation: { kind: "write-close", chars: "approved\n" }, wait: 1000, tokens: 1000,
      }, 10000, undefined, true));
      const sleeper = await collect(await client.request("spawn", { launch: await launch("sleep 20"), wait: 250, tokens: 0 }));
      const controller = new AbortController();
      const poll = client.request("input", {
        id: sleeper.job.id, operation: { kind: "poll", chars: "" }, wait: 10000, tokens: 0,
      }, 15000, controller.signal);
      controller.abort();
      await assert.rejects(poll, /cancelled/);
      assert.equal((await client.request("list", { id: sleeper.job.id })).jobs[0].state, "running");
      await client.request("stop", { id: sleeper.job.id });
      await client.request("revoke", {});
    } finally {
      const warnings = await client.close();
      assert.deepEqual(warnings, []);
    }
  });
});
test("silent jobs yield after ten seconds without timeout; real stdout/stderr floods stay bounded", {
  skip: process.platform !== "darwin", timeout: 30000,
}, async () => {
  await temporary(async (dir) => {
    const client = new ExecutorClient("long-and-flood", process.execPath, () => {}, () => {});
    try {
      await client.request("init", { contract: CONTRACT, policy: { ...document,
        filesystem: { ...document.filesystem, allowWrite: [dir] } }, runtimeParent: dir }, 20000);
      const started = Date.now();
      const silent = await client.request("spawn", {
        launch: await prepareLaunch({ cmd: "sleep 11", login: false }, dir, {}), wait: 10000, tokens: 0,
      }, 20000);
      assert.ok(Date.now() - started >= 9900);
      assert.ok(silent.yielded);
      await client.request("ack", { id: silent.job.id, chunk: silent.chunk });
      const finished = await client.request("input", {
        id: silent.job.id, operation: { kind: "poll", chars: "" }, wait: 5000, tokens: 0,
      });
      assert.equal(finished.job.id, silent.job.id);
      assert.equal(finished.job.exit_code, 0);
      await client.request("ack", { id: finished.job.id, chunk: finished.chunk });
      const code = 'process.stdout.write("o".repeat(2*1024*1024)); process.stderr.write("e".repeat(2*1024*1024));';
      const flood = await client.request("spawn", {
        launch: await prepareLaunch({ cmd: `${shellQuote(process.execPath)} -e ${shellQuote(code)}`, login: false }, dir, {}),
        wait: 1000, tokens: 256,
      });
      assert.equal(flood.job.exit_code, 0);
      assert.ok(flood.omitted > 0);
      assert.ok(Buffer.byteLength(flood.output) <= 1024);
      assert.equal((await stat(flood.log)).size, 4 * 1024 * 1024);
      await client.request("ack", { id: flood.job.id, chunk: flood.chunk });
    } finally { assert.deepEqual(await client.close(), []); }
  });
});
test("saved-log quotas stop logging without stopping output drain", async () => {
  await temporary(async (dir) => {
    const quota = { bytes: 0 };
    const log = join(dir, "quota.log");
    const output = new OutputStore(log, quota);
    const block = Buffer.alloc(1024 * 1024, "q");
    for (let i = 0; i < 33; i++) output.append(block, i % 2);
    const result = output.reserve(0);
    assert.equal(result.output, "");
    assert.ok(result.logCapped && result.omitted > 0);
    output.ack(result.chunk); output.close();
    assert.equal((await stat(log)).size, 32 * 1024 * 1024);
    const runtimeLog = join(dir, "runtime-quota.log");
    const exhausted = new OutputStore(runtimeLog, { bytes: 256 * 1024 * 1024 });
    exhausted.append(Buffer.from("still draining"), 0);
    assert.equal(exhausted.reserve(1000).output, "still draining");
    exhausted.close();
    assert.equal((await stat(runtimeLog)).size, 0);
  });
});
