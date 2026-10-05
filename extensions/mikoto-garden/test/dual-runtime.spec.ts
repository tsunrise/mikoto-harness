import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { MikotoPolicyDocument } from "mikoto-types";
import { ExecutorClient } from "../src/executor-client.ts";
import { prepareLaunch, shellQuote } from "../src/launch.ts";
import { CONTRACT } from "../src/protocol.ts";

test("independent executors pin distinct network policies and keep host environments clean", {
  skip: process.platform !== "darwin", timeout: 30000,
}, async () => {
  const parent = fileURLToPath(new URL("../test-runtime/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const dir = await realpath(await mkdtemp(join(parent, "dual-")));
  const servers: Server[] = [];
  const listen = async () => {
    const server = createServer((_request, response) => { response.end("fixture"); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `127.0.0.1:${address.port}`;
  };
  const leftAddress = await listen();
  const rightAddress = await listen();
  const previousProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = "http://upstream-must-not-be-used.invalid:9";
  const left = new ExecutorClient("left", process.execPath, () => {}, () => {});
  const right = new ExecutorClient("right", process.execPath, () => {}, () => {});
  const policy = (address: string): MikotoPolicyDocument => ({
    filesystem: { denyRead: [], allowRead: [], allowWrite: [dir], denyWrite: [] },
    network: { allowedDomains: [address], deniedDomains: [], allowLocalBinding: false, allowUnixSockets: [] },
  });
  const launch = async (client: ExecutorClient, cmd: string, elevated = false) => {
    const prepared = await prepareLaunch({
      cmd, login: false, sandbox_permissions: elevated ? "require_escalated" : "use_default",
    }, dir, {});
    const result = await client.request("spawn", { launch: prepared, wait: 1000, tokens: 1000 }, 10000, undefined, elevated);
    await client.request("ack", { id: result.job.id, chunk: result.chunk });
    assert.equal(result.job.exit_code, 0);
    return result.output;
  };
  const curl = (address: string) =>
    `/usr/bin/curl -sS --max-time 3 -o /dev/null -w '%{http_code}' ${shellQuote(`http://${address}/`)}`;
  try {
    await Promise.all([
      left.request("init", { contract: CONTRACT, policy: policy(leftAddress), runtimeParent: dir }),
      right.request("init", { contract: CONTRACT, policy: policy(rightAddress), runtimeParent: dir }),
    ]);
    assert.equal(await launch(left, curl(leftAddress)), "200");
    assert.equal(await launch(right, curl(rightAddress)), "200");
    assert.equal(await launch(left, curl(rightAddress)), "403");
    assert.equal(await launch(right, curl(leftAddress)), "403");
    const markers = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "CLAUDE_CODE_SRT", "SANDBOX_RUNTIME", "CLAUDE_CODE_TMPDIR"];
    const check = markers.map((key) => `test -z "\${${key}+x}"`).join(" && ");
    assert.equal(await launch(left, `${check} && printf clean`, true), "clean");
    await left.close();
    assert.equal(await launch(right, curl(rightAddress)), "200");
  } finally {
    await Promise.all([left.close(), right.close()]);
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    if (previousProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previousProxy;
    await rm(dir, { recursive: true, force: true });
  }
});
