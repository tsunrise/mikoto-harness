import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { z } from "zod";
import type { MikotoPolicyDocument } from "mikoto-types";
import { ExecutorClient } from "../src/executor-client.ts";
import { CapabilityRegistry } from "../src/capability-registry.ts";
import { CapabilityServer } from "../src/capability-server.ts";
import { prepareLaunch, shellQuote } from "../src/launch.ts";
import { CONTRACT, type Delivery } from "../src/protocol.ts";

test("two independent compiled runtimes: exact grants, token separation, clean host environment, revocation", {
  skip: process.platform !== "darwin", timeout: 30000,
}, async () => {
  const parent = fileURLToPath(new URL("../test-runtime/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const dir = await realpath(await mkdtemp(join(parent, "dual-")));
  const registry = new CapabilityRegistry();
  registry.bind({
    owner: "test",
    method: "POST",
    path: "/probe",
    bodyFormat: "text",
    bodySchema: z.string(),
    async handler() {
      return { status: 204 };
    },
  });
  const leftServer = await CapabilityServer.start(registry, () => {});
  const rightServer = await CapabilityServer.start(registry, () => {});
  assert.ok(leftServer?.endpoint && rightServer?.endpoint);
  const leftEndpoint = leftServer.endpoint;
  const rightEndpoint = rightServer.endpoint;
  const previousProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = "http://upstream-must-not-be-used.invalid:9";
  const left = new ExecutorClient("left", process.execPath, () => {}, () => {});
  const right = new ExecutorClient("right", process.execPath, () => {}, () => {});
  const document: MikotoPolicyDocument = {
    filesystem: { denyRead: [], allowRead: [], allowWrite: [dir], denyWrite: [] },
    network: { allowedDomains: [`127.0.0.1:${rightEndpoint.port}`], deniedDomains: ["*", "127.0.0.1", `127.0.0.1:${leftEndpoint.port}`], allowLocalBinding: false, allowUnixSockets: [] },
  };
  const curl = (url: string, token: string) =>
    `/usr/bin/curl -sS --max-time 3 -o /dev/null -w '%{http_code}' -H ${shellQuote(`Authorization: Bearer ${token}`)} -d Hello ${shellQuote(url + "/probe")}`;
  const launch = async (client: ExecutorClient, endpoint: typeof leftEndpoint | undefined, cmd: string, mode = "sandboxed") => {
    const prepared = await prepareLaunch({
      cmd, login: false, stdin: false, sandbox_permissions: mode === "unsandboxed" ? "require_escalated" : "use_default",
    }, dir, { PI_SESSION_ID: "test" }, endpoint);
    const result = await client.request("spawn", { launch: prepared, wait: 1000, tokens: 1000 }, 10000, undefined, mode === "unsandboxed") as Delivery;
    await client.request("ack", { id: result.job.id, chunk: result.chunk });
    assert.equal(result.job.exit_code, 0);
    return result.output;
  };
  try {
    await Promise.all([
      left.request("init", { contract: CONTRACT, policy: document, runtimeParent: dir, endpoint: { port: leftEndpoint.port } }),
      right.request("init", { contract: CONTRACT, policy: document, runtimeParent: dir, endpoint: { port: rightEndpoint.port } }),
    ]);
    assert.equal(await launch(left, leftEndpoint, curl(leftEndpoint.url, leftEndpoint.token)), "204");
    assert.equal(await launch(right, rightEndpoint, curl(rightEndpoint.url, rightEndpoint.token)), "204");
    assert.equal(await launch(left, leftEndpoint, curl(rightEndpoint.url, rightEndpoint.token)), "403");
    assert.equal(await launch(right, rightEndpoint, curl(leftEndpoint.url, leftEndpoint.token)), "403");
    assert.equal(await launch(left, leftEndpoint, curl(leftEndpoint.url.replace("127.0.0.1", "localhost"), leftEndpoint.token)), "403");
    assert.equal((await fetch(`${rightEndpoint.url}/probe`, {
      method: "POST", body: "Hello", headers: { authorization: `Bearer ${leftEndpoint.token}` },
    })).status, 401);
    const markers = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "CLAUDE_CODE_SRT", "SANDBOX_RUNTIME", "CLAUDE_CODE_TMPDIR"];
    const check = markers.map((key) => `test -z "\${${key}+x}"`).join(" && ");
    assert.equal(await launch(left, leftEndpoint, `${check} && ${curl(leftEndpoint.url, leftEndpoint.token)}`, "unsandboxed"), "204");
    leftServer.stopAdmitting();
    await left.request("revoke", {});
    assert.equal(await launch(left, undefined, curl(leftEndpoint.url, leftEndpoint.token)), "403");
    assert.equal(await launch(right, rightEndpoint, curl(rightEndpoint.url, rightEndpoint.token)), "204");
  } finally {
    leftServer.stopAdmitting(); rightServer.stopAdmitting();
    await Promise.all([left.close(), right.close()]);
    await Promise.all([leftServer.close(), rightServer.close()]);
    registry.close();
    if (previousProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previousProxy;
    await rm(dir, { recursive: true, force: true });
  }
});
