import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { MikotoPolicyDocument } from "mikoto-types";
import { ExecutorClient } from "../src/executor-client.ts";
import { prepareLaunch, shellQuote } from "../src/launch.ts";
import { CONTRACT, type Delivery } from "../src/protocol.ts";

function listen(server: Server, target: number | string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (typeof target === "string") server.listen(target, resolve);
    else server.listen(target, "127.0.0.1", resolve);
  });
}

test("policy grants direct loopback TCP and listed unix sockets only when configured", {
  skip: process.platform !== "darwin", timeout: 30000,
}, async () => {
  const parent = fileURLToPath(new URL("../test-runtime/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const dir = await realpath(await mkdtemp(join(parent, "ipc-")));
  // Unix socket paths are limited to ~104 bytes, so keep them short.
  const sockets = await realpath(await mkdtemp("/tmp/gipc-"));
  const allowedSocket = join(sockets, "a.sock");
  const otherSocket = join(sockets, "b.sock");
  const servers = [createServer((s) => s.end()), createServer((s) => s.end()), createServer((s) => s.end())];
  await listen(servers[0], 0);
  await listen(servers[1], allowedSocket);
  await listen(servers[2], otherSocket);
  const port = (servers[0].address() as { port: number }).port;

  const policy = (network: Partial<MikotoPolicyDocument["network"]>): MikotoPolicyDocument => ({
    filesystem: { denyRead: [], allowRead: [], allowWrite: [dir], denyWrite: [] },
    network: { allowedDomains: [], deniedDomains: ["*"], allowLocalBinding: false, allowUnixSockets: [], ...network },
  });
  const closed = new ExecutorClient("closed", process.execPath, () => {}, () => {});
  const open = new ExecutorClient("open", process.execPath, () => {}, () => {});
  const connects = async (client: ExecutorClient, target: string) => {
    const script = `require("net").connect(${target}).on("connect",()=>process.exit(0)).on("error",()=>process.exit(3))`;
    const prepared = await prepareLaunch({
      cmd: `${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
      login: false, stdin: false, sandbox_permissions: "use_default",
    }, dir, { PI_SESSION_ID: "test" }, undefined);
    const result = await client.request("spawn", { launch: prepared, wait: 5000, tokens: 1000 }, 10000) as Delivery;
    await client.request("ack", { id: result.job.id, chunk: result.chunk });
    return result.job.exit_code === 0;
  };
  try {
    await Promise.all([
      closed.request("init", { contract: CONTRACT, policy: policy({}), runtimeParent: dir }),
      open.request("init", {
        contract: CONTRACT,
        policy: policy({ allowLocalBinding: true, allowUnixSockets: [allowedSocket] }),
        runtimeParent: dir,
      }),
    ]);
    const tcp = `{host:"127.0.0.1",port:${port}}`;
    const unix = (path: string) => `{path:${JSON.stringify(path)}}`;
    assert.equal(await connects(closed, tcp), false);
    assert.equal(await connects(closed, unix(allowedSocket)), false);
    assert.equal(await connects(open, tcp), true);
    assert.equal(await connects(open, unix(allowedSocket)), true);
    assert.equal(await connects(open, unix(otherSocket)), false);
  } finally {
    await Promise.all([closed.close(), open.close()]);
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await rm(dir, { recursive: true, force: true });
    await rm(sockets, { recursive: true, force: true });
  }
});
