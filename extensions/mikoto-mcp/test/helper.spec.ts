import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CapabilityRegistry } from "../../mikoto-garden/src/capability-registry.ts";
import { CapabilityServer } from "../../mikoto-garden/src/capability-server.ts";
import { cleanup, directory, Fake, harness, png, setup } from "./helpers.ts";

const helperPath = fileURLToPath(new URL("../skills/mcp/scripts/mcp.mjs", import.meta.url));
type Run = { code: number | null; stdout: string; stderr: string };
type Endpoint = { url: string; token: string };

function run(args: string[], tmp: string, endpoint?: Endpoint, stdin?: string): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, GARDEN_SERVER: endpoint?.url ?? "", GARDEN_TOKEN: endpoint?.token ?? "" };
  // Loopback fixtures must not depend on the ambient proxy configuration.
  for (const key of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
  const child = spawn(process.execPath, [helperPath, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end(stdin);
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  return new Promise<Run>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  }).finally(() => clearTimeout(timer));
}

async function garden(t: TestContext, fake: Fake) {
  const paths = await setup(t);
  const routes = new CapabilityRegistry();
  const h = harness({ ...paths, adapter: () => fake, emit: binding => binding.callback?.(routes.bind(binding)) });
  const server = await CapabilityServer.start(routes, () => {});
  assert.ok(server?.endpoint);
  cleanup(t, () => routes.close());
  cleanup(t, () => server.close());
  cleanup(t, () => h.stop());
  await h.start();
  return { endpoint: server.endpoint, tmp: await directory(t) };
}

const savedPath = (stdout: string) => {
  const match = stdout.match(/^[^\n]*?(\/\S+response\.json)\n/);
  assert.ok(match, "saved response path is announced first");
  return match[1];
};

test("helper prints only text content and saves the complete response privately", async t => {
  const fake = new Fake().ready();
  const text = "line one\nline two";
  fake.response = async () => ({ content: [{ type: "text", text }] });
  const { endpoint, tmp } = await garden(t, fake);
  const result = await run(["browser", "takeScreenshot", '{"pageUrl":"https://example.com"}'], tmp, endpoint);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, text + "\n");
  assert.deepEqual(fake.calls, [{ name: "takeScreenshot", args: { pageUrl: "https://example.com" } }]);
  const [dir] = await readdir(tmp);
  const file = join(tmp, dir, "response.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved.result.content, [{ type: "text", text }]);
  assert.ok(!result.stdout.includes(endpoint.token) && !result.stderr.includes(endpoint.token));
});

test("helper reads stdin arguments and defaults omitted arguments to an empty object", async t => {
  const fake = new Fake().ready();
  const { endpoint, tmp } = await garden(t, fake);
  assert.equal((await run(["browser", "takeScreenshot", "-"], tmp, endpoint, '{"a":[1,2]}')).code, 0);
  assert.equal((await run(["browser", "takeScreenshot"], tmp, endpoint)).code, 0);
  assert.deepEqual(fake.calls.map(c => c.args), [{ a: [1, 2] }, {}]);
});

test("helper announces the saved response when it omits structured or media data", async t => {
  const fake = new Fake().ready();
  const structured = { pins: [{ destination: "default", version: "1.2.3" }] };
  const responses: CallToolResult[] = [
    { content: [{ type: "text", text: "summary" }], structuredContent: structured },
    { content: [], structuredContent: structured },
    { content: [{ type: "image", data: png, mimeType: "image/png" }] },
  ];
  fake.response = async () => responses.shift()!;
  const { endpoint, tmp } = await garden(t, fake);

  const both = await run(["browser", "takeScreenshot"], tmp, endpoint);
  assert.equal(both.code, 0, both.stderr);
  assert.ok(both.stdout.endsWith("\nsummary\n"));
  assert.deepEqual(JSON.parse(await readFile(savedPath(both.stdout), "utf8")).result.structuredContent, structured);

  const only = await run(["browser", "takeScreenshot"], tmp, endpoint);
  assert.equal(only.code, 0, only.stderr);
  assert.deepEqual(JSON.parse(only.stdout), structured);

  const image = await run(["browser", "takeScreenshot"], tmp, endpoint);
  assert.equal(image.code, 0, image.stderr);
  savedPath(image.stdout);
  const artifact = image.stdout.trim().split("\n").at(-1)!;
  assert.match(artifact, /image\/png/);
  assert.match(artifact, /imageReadable/);
  const imagePath = artifact.slice(artifact.lastIndexOf(" ") + 1);
  assert.equal((await readFile(imagePath)).subarray(1, 4).toString(), "PNG");
});

test("helper distinguishes tool errors from call failures without retrying", async t => {
  const fake = new Fake().ready();
  let calls = 0;
  fake.response = async () => {
    if (++calls === 1) return { isError: true, content: [{ type: "text", text: "no such service" }] };
    throw new Error("connection reset");
  };
  const { endpoint, tmp } = await garden(t, fake);

  const toolError = await run(["browser", "takeScreenshot"], tmp, endpoint);
  assert.equal(toolError.code, 2);
  assert.equal(toolError.stdout, "no such service\n");

  const failed = await run(["browser", "takeScreenshot"], tmp, endpoint);
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /mcp_error/);
  assert.equal(calls, 2);

  const unknown = await run(["browser", "missing"], tmp, endpoint);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /unknown_tool/);
  assert.equal(calls, 2);
});

test("helper rejects malformed input and endpoints locally without echoing secrets", async t => {
  const tmp = await directory(t);
  const endpoint = { url: "http://127.0.0.1:1", token: "token-canary" };
  for (const args of [[], ["browser"], ["", "tool"], ["browser", "tool", "{"], ["browser", "tool", "[]"],
    ["browser", "tool", "null"], ["browser", "tool", "{}", "extra"], ["browser", "tool", JSON.stringify({ x: "y".repeat(16385) })]]) {
    const result = await run(args, tmp, endpoint);
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(endpoint.token));
  }
  for (const url of ["https://evil.example", "http://u:p@127.0.0.1:1", "http://127.0.0.1:1/other"]) {
    const result = await run(["browser", "tool"], tmp, { ...endpoint, url });
    assert.equal(result.code, 1);
    assert.ok(!result.stderr.includes(url) && !result.stderr.includes(endpoint.token));
  }
  assert.equal((await run(["browser", "tool"], tmp)).code, 1);
  assert.equal((await run(["browser", "tool", "-"], tmp, endpoint, "x".repeat(16385))).code, 1);
  assert.deepEqual(await readdir(tmp), []);
});
