import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";
import { z } from "zod";
import { CapabilityRegistry } from "../src/capability-registry.ts";
import { CapabilityServer, HTTP_LIMITS } from "../src/capability-server.ts";

test("HTTP framing, byte limits, UTF-8, schema failure and bounded non-leaking errors", async () => {
  const registry = new CapabilityRegistry();
  let calls = 0;
  registry.bind({
    owner: "test", method: "POST", path: "/text", bodyFormat: "text", bodySchema: z.string(),
    async handler() { calls++; return { status: 204 }; },
  });
  registry.bind({
    owner: "test", method: "POST", path: "/throws", bodySchema: z.any().transform(() => { throw new Error("SECRET ZOD DATA"); }),
    async handler() { assert.fail("Schema exception must not invoke handler"); },
  });
  registry.bind({
    owner: "test", method: "GET", path: "/redirect", bodySchema: z.undefined(),
    async handler() { return { status: 302, headers: { location: "http://unrelated.invalid" } }; },
  });
  const server = await CapabilityServer.start(registry, () => {});
  assert.ok(server?.endpoint);
  const { token, url, port } = server.endpoint;
  const raw = (target: string, headers: string, body = Buffer.alloc(0)) => new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let output = "";
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("Raw HTTP timeout")); });
    socket.on("data", (chunk) => { output += chunk.toString("utf8"); });
    socket.on("end", () => resolve(output));
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(`POST ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\n${headers}\r\n`);
      socket.end(body);
    });
  });
  try {
    assert.match(await raw("/text", "Content-Length: 1\r\n", Buffer.from([0xff])), /^HTTP\/1.1 400/);
    assert.match(await raw("/text", "Transfer-Encoding: chunked\r\n",
      Buffer.from(`5000\r\n${"x".repeat(0x5000)}\r\n0\r\n\r\n`)), /^HTTP\/1.1 413/);
    assert.match(await raw("/text", `Authorization: Bearer ${token}\r\nContent-Length: 0\r\n`), /^HTTP\/1.1 400/);
    for (const target of ["/%74ext", "/text/../text", "//text", "/text?x=1", `http://127.0.0.1:${port}/text`]) {
      assert.match(await raw(target, "Content-Length: 0\r\n"), /^HTTP\/1.1 400/, target);
    }
    assert.equal(calls, 0);
    const auth = { authorization: `Bearer ${token}` };
    const result = await fetch(`${url}/throws`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    assert.equal(result.status, 500);
    assert.doesNotMatch(await result.text(), /SECRET/);
    assert.equal((await fetch(`${url}/redirect`, { headers: auth, redirect: "manual" })).status, 500);
  } finally { await server.close(); registry.close(); }
});
test("schema disposal prevents late handlers; timed-out work retains concurrency slots", { timeout: 90000 }, async () => {
  const registry = new CapabilityRegistry();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = 0;
  let handlers = 0;
  const binding = registry.bind({
    owner: "test", method: "GET", path: "/slow",
    bodySchema: z.undefined().transform(async () => { entered++; await gate; return "parsed"; }),
    async handler() { handlers++; return { status: 204 }; },
  });
  const server = await CapabilityServer.start(registry, () => {});
  assert.ok(server?.endpoint);
  const { url, token } = server.endpoint;
  const request = () => fetch(`${url}/slow`, { headers: { authorization: `Bearer ${token}` } });
  try {
    const running = Array.from({ length: HTTP_LIMITS.concurrent }, request);
    while (entered < HTTP_LIMITS.concurrent) await new Promise((resolve) => setTimeout(resolve, 10));
    const responses = await Promise.all(running);
    for (const response of responses) assert.equal(response.status, 504);
    assert.equal((await request()).status, 429);
    if (binding.ok) binding.dispose();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(handlers, 0);
  } finally { release(); await server.close(); registry.close(); }
});

test("responses are byte-bounded at 100 MiB, including multibyte UTF-8", { timeout: 30000 }, async () => {
  const registry = new CapabilityRegistry();
  let body = "";
  registry.bind({
    owner: "test", method: "GET", path: "/large", bodySchema: z.undefined(),
    async handler() { return { status: 200, body }; },
  });
  const server = await CapabilityServer.start(registry, () => {});
  assert.ok(server?.endpoint);
  const { url, token } = server.endpoint;
  try {
    // Keep one large string at a time and drain bytes rather than asking fetch
    // to retain a second 100 MiB text copy in the test process.
    for (const [size, status] of [[65538, 200], [100 * 1024 * 1024, 200], [100 * 1024 * 1024 + 1, 500]]) {
      body = "é".repeat(Math.floor(size / 2)) + (size % 2 ? "x" : "");
      const response = await fetch(`${url}/large`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, status);
      if (status === 200) {
        let bytes = 0;
        for await (const chunk of response.body!) bytes += chunk.byteLength;
        assert.equal(bytes, size);
      } else {
        const error = await response.text();
        assert.ok(error.length < 1000);
        assert.ok(!error.includes("é"));
      }
      body = "";
    }
  } finally { await server.close(); registry.close(); }
});

test("a handler may finish after the former five-second deadline", { timeout: 15000 }, async () => {
  const registry = new CapabilityRegistry();
  registry.bind({
    owner: "test", method: "GET", path: "/wait", bodySchema: z.undefined(),
    async handler({ signal }) {
      await new Promise((resolve) => setTimeout(resolve, 5100));
      signal.throwIfAborted();
      return { status: 200, body: "completed" };
    },
  });
  const server = await CapabilityServer.start(registry, () => {});
  assert.ok(server?.endpoint);
  try {
    const response = await fetch(`${server.endpoint.url}/wait`, {
      headers: { authorization: `Bearer ${server.endpoint.token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "completed");
  } finally { await server.close(); registry.close(); }
});
