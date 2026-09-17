import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { z } from "zod";
import { CapabilityRegistry } from "../../mikoto-garden/src/capability-registry.ts";
import { CapabilityServer } from "../../mikoto-garden/src/capability-server.ts";
import { fixture, deferred } from "./fixtures.ts";

export const helperPath = fileURLToPath(new URL("../skills/web/scripts/web.mjs", import.meta.url));
type HelperResult = { code: number | null; stdout: string; stderr: string };

export function helper(
  path: string,
  args: string[],
  directory: string,
  endpoint?: { url: string; token: string },
  stdin?: string,
  nodeArguments: string[] = [],
  environment: NodeJS.ProcessEnv = {},
): { child: ChildProcessWithoutNullStreams; done: Promise<HelperResult> } {
  const child = spawn(process.execPath, [...nodeArguments, path, ...args], {
    env: {
      ...process.env, TMPDIR: directory,
      GARDEN_SERVER: endpoint?.url ?? "", GARDEN_TOKEN: endpoint?.token ?? "",
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(stdin);
  // A test timeout does not automatically kill child processes. Bound the
  // fixture itself so a broken transport cannot keep the suite alive.
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  const done = new Promise<HelperResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  }).finally(() => clearTimeout(timer));
  return { child, done };
}

test("real helper and Garden: argv/stdin, saved complete output, schema rejection, and auth", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-helper-test-"));
  const routes = new CapabilityRegistry();
  const text = "citeturn0search0\n" + "page text\n".repeat(9000);
  const results = [{ type: "text_result", ref_id: "turn0search0", url: "https://example.com", future: true }];
  let requests = 0;
  const h = fixture({
    emit(event) { event.callback?.(routes.bind(event)); },
    fetch: async () => { requests++; return Response.json({ output: text, results, encrypted_output: "never-save" }); },
  });
  let server: CapabilityServer | undefined;
  try {
    await h.start();
    server = await CapabilityServer.start(routes, () => {});
    assert.ok(server?.endpoint);
    for (const stdin of [false, true]) {
      const json = '{"search_query":[{"q":"example"}]}';
      const run: HelperResult = await helper(helperPath, [stdin ? "-" : json], directory, server.endpoint, stdin ? json : undefined).done;
      assert.equal(run.code, 0, run.stderr);
      const lines = run.stdout.split("\n");
      const responsePath = lines[0].slice(lines[0].indexOf(": ") + 2);
      const outputPath = lines[1].slice(lines[1].indexOf(": ") + 2);
      assert.ok(responsePath.startsWith(directory));
      assert.equal(await readFile(outputPath, "utf8"), text);
      assert.deepEqual(JSON.parse(await readFile(responsePath, "utf8")), { output: text, results });
      assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
      assert.equal((await stat(join(outputPath, ".."))).mode & 0o777, 0o700);
      assert.equal(run.stdout.slice(run.stdout.indexOf("\n\n") + 2), text);
      assert.ok(!run.stdout.includes(server.endpoint.token));
    }
    assert.equal(requests, 2);
    for (const input of ['{"screenshot":[{"ref_id":"r","pageno":0}]}', '{"search_query":[]}', '{"open":[{"ref_id":"file:///x"}]}']) {
      const run: HelperResult = await helper(helperPath, [input], directory, server.endpoint).done;
      assert.notEqual(run.code, 0);
      assert.equal(run.stdout, "");
    }
    const direct = await fetch(`${server.endpoint.url}/web/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify({ search_query: [{ q: "x".repeat(17000) }] }),
    });
    assert.equal(direct.status, 413);
    await direct.body?.cancel();
    assert.equal(requests, 2);
    const badAuth = await helper(helperPath, ['{"open":[{"ref_id":"r"}]}'], directory,
      { ...server.endpoint, token: "wrong-token" }).done;
    assert.notEqual(badAuth.code, 0);
    assert.ok(!badAuth.stderr.includes("wrong-token"));
    h.stop();
    const unbound = await helper(helperPath, ['{"open":[{"ref_id":"r"}]}'], directory, server.endpoint).done;
    assert.notEqual(unbound.code, 0);
  } finally {
    h.stop();
    await server?.close();
    routes.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("helper rejects malformed/oversized input locally and never echoes endpoint tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-helper-invalid-"));
  try {
    const endpoint = { url: "http://127.0.0.1:1", token: "token-canary" };
    for (const args of [[], ["{}", "extra"], ["{"], ["x".repeat(16385)]]) {
      const run = await helper(helperPath, args, directory, endpoint).done;
      assert.notEqual(run.code, 0);
      assert.equal(run.stdout, "");
      assert.ok(!run.stderr.includes(endpoint.token));
    }
    for (const url of ["https://evil.example", "http://u:p@127.0.0.1:1", "http://127.0.0.1:1/other"]) {
      const run = await helper(helperPath, ["{}"], directory, { ...endpoint, url }).done;
      assert.notEqual(run.code, 0);
      assert.equal(run.stdout, "");
      assert.ok(!run.stderr.includes(url));
    }
    const missing = await helper(helperPath, ["{}"], directory).done;
    assert.notEqual(missing.code, 0);
    const oversized = await helper(helperPath, ["-"], directory, endpoint, "x".repeat(16385)).done;
    assert.notEqual(oversized.code, 0);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("helper honors the provided HTTP proxy without changing its bypass list", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-helper-proxy-"));
  const routes = new CapabilityRegistry();
  routes.bind({
    owner: "test", method: "POST", path: "/web/run", bodySchema: z.strictObject({}),
    async handler() { return { status: 200, body: '{"output":"proxied","results":[]}' }; },
  });
  const server = await CapabilityServer.start(routes, () => {});
  const proxy = createServer();
  const sockets = new Set<ReturnType<typeof connect>>();
  let connects = 0;
  try {
    assert.ok(server?.endpoint);
    const endpoint = server.endpoint;
    // Node versions may use absolute-form HTTP requests or CONNECT tunnels.
    // Support both, just as Garden's real proxy does.
    proxy.on("request", (req, res) => {
      connects++;
      if (req.url !== `${endpoint.url}/web/run`) { res.writeHead(502).end(); return; }
      const upstream = httpRequest(`${endpoint.url}/web/run`, {
        method: req.method, headers: { ...req.headers, host: `127.0.0.1:${endpoint.port}` },
      }, (response) => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      });
      upstream.on("error", () => res.destroy());
      req.on("error", () => upstream.destroy());
      req.pipe(upstream);
    });
    proxy.on("connect", (req, socket, head) => {
      connects++;
      if (req.url !== `127.0.0.1:${endpoint.port}`) { socket.destroy(); return; }
      const upstream = connect(endpoint.port, "127.0.0.1");
      sockets.add(upstream);
      upstream.once("close", () => sockets.delete(upstream));
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    const environment = {
      HTTP_PROXY: proxyUrl, http_proxy: proxyUrl,
      HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, NO_PROXY: "", no_proxy: "",
    };
    const proxied = await helper(helperPath, ["{}"], directory, endpoint, undefined, [], environment).done;
    assert.equal(proxied.code, 0, proxied.stderr);
    assert.equal(connects, 1);
    const bypassed = await helper(helperPath, ["{}"], directory, endpoint, undefined, [], {
      ...environment, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1",
    }).done;
    assert.equal(bypassed.code, 0, bypassed.stderr);
    assert.equal(connects, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await server?.close();
    routes.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("helper cancellation closes HTTP request and aborts upstream work", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-helper-abort-"));
  const routes = new CapabilityRegistry();
  const entered = deferred<void>();
  const aborted = deferred<void>();
  const h = fixture({
    emit(event) { event.callback?.(routes.bind(event)); },
    fetch: async (_url, init) => {
      entered.resolve();
      return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => {
        aborted.resolve(); reject(new Error("sensitive transport error"));
      }, { once: true }));
    },
  });
  let server: CapabilityServer | undefined;
  let child: ReturnType<typeof helper> | undefined;
  try {
    await h.start();
    server = await CapabilityServer.start(routes, () => {});
    assert.ok(server?.endpoint);
    child = helper(helperPath, ['{"search_query":[{"q":"test"}]}'], directory, server.endpoint);
    await entered.promise;
    child.child.kill("SIGINT");
    const result = await child.done;
    assert.equal(result.code, 130);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("sensitive"));
    await aborted.promise;
  } finally {
    if (child && child.child.exitCode === null && child.child.signalCode === null) {
      child.child.kill("SIGTERM");
      await once(child.child, "close");
    }
    h.stop();
    await server?.close();
    routes.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("helper keeps malformed/error responses out of diagnostics and handles save failures", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-helper-errors-"));
  const routes = new CapabilityRegistry();
  let response = { status: 200, body: "{}" };
  routes.bind({
    owner: "test", method: "POST", path: "/web/run", bodySchema: z.strictObject({}),
    async handler() { return response; },
  });
  const server = await CapabilityServer.start(routes, () => {});
  try {
    assert.ok(server?.endpoint);
    for (const [status, body] of [
      [500, "<html>SECRET upstream diagnostic</html>"],
      [502, '{"error":{"code":"upstream_error","message":"SECRET"}}'],
      [200, '{"output":false,"SECRET":true}'],
      [200, "SECRET invalid JSON"],
    ] as const) {
      response = { status, body };
      const result: HelperResult = await helper(helperPath, ["{}"], directory, server.endpoint).done;
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.ok(!result.stderr.includes("SECRET"));
    }
    response = { status: 200, body: '{"output":"page","results":[]}' };
    const failedSave = await helper(helperPath, ["{}"], join(directory, "missing"), server.endpoint).done;
    assert.equal(failedSave.code, 1);
    assert.equal(failedSave.stdout, "");
  } finally {
    await server?.close();
    routes.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupt also terminates a helper blocked behind a slow stdout consumer", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-helper-backpressure-"));
  let running: ReturnType<typeof helper> | undefined;
  try {
    // This regression is about process stdout, not HTTP. Inject the completed
    // fetch so it can also be reproduced without a loopback-server permission.
    const preload = join(directory, "fetch.mjs");
    await writeFile(preload, 'globalThis.fetch = async () => Response.json({ output: "x".repeat(2 * 1024 * 1024) });');
    running = helper(helperPath, ["{}"], directory,
      { url: "http://127.0.0.1:1", token: "fake" }, undefined, ["--import", preload]);
    running.child.stdout.pause();
    // Wait for artifact creation, then let the large write fill the pipe.
    const deadline = Date.now() + 5000;
    while (!(await readdir(directory)).some((name) => name.startsWith("web-"))) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const exit = once(running.child, "exit");
    running.child.kill("SIGINT");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const [code] = await Promise.race([
      exit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Helper did not exit after interrupt")), 2000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(code, 130);
    running.child.stdout.resume();
    await running.done;
  } finally {
    if (running && running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill("SIGKILL");
      running.child.stdout.resume();
      await running.done;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
