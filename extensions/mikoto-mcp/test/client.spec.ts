import { cleanup } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAdapter, boundedBody } from "../src/client.ts";
import { budget } from "../src/errors.ts";
import { tool } from "./helpers.ts";

function reply(request: { id: number; method: string; params?: { protocolVersion?: string } }) {
  return { jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
    ? { protocolVersion: request.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
    : request.method === "tools/list" ? { tools: [tool()] } : { content: [{ type: "text", text: "ok" }], isError: true } };
}

test("real stdio transport preserves argv/env/cwd, paginates via public request and shuts down", async t => {
  const errors: unknown[] = [];
  const adapter = createAdapter({
    type: "stdio", command: process.execPath, args: [fileURLToPath(new URL("fixtures/server.mjs", import.meta.url)), "literal;not-shell"],
    cwd: process.cwd(), env: { TEST_KEY: "explicit" },
  }, e => errors.push(e));
  cleanup(t, () => adapter.close());
  const timer = budget([], 5000); cleanup(t, timer.dispose);
  const deadline = Date.now() + 5000;
  assert.equal(await adapter.connect(timer.signal, deadline), true);
  const first = await adapter.list(undefined, timer.signal, deadline);
  assert.equal(first.tools[0].name, "echo");
  assert.equal((await adapter.list(first.nextCursor, timer.signal, deadline)).tools[0].name, "second");
  const result = await adapter.call("echo", { arbitrary: 1 }, timer.signal, deadline);
  const text = result.content[0];
  assert.equal(text.type, "text");
  if (text.type === "text") {
    const echo = JSON.parse(text.text);
    assert.deepEqual(echo.arguments, { arbitrary: 1 });
    assert.deepEqual(echo.argv, ["literal;not-shell"]);
    assert.equal(echo.cwd, process.cwd());
    assert.equal(echo.key, "explicit");
    assert.equal(echo.garden, null);
  }
  await adapter.close();
  assert.deepEqual(errors, []);
});

for (const type of ["http", "sse"] as const) test(`${type} uses static headers on every leg, no redirects or automatic auth`, async t => {
  const calls: { method: string; headers: Headers }[] = [];
  const errors: unknown[] = [];
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const adapter = createAdapter({ type, url: "https://example.com/mcp", headers: { authorization: "Bearer static", "x-key": "key" } },
    e => errors.push(e), { fetch: async (input, init) => {
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      calls.push({ method, headers });
      assert.equal(init?.redirect, "error");
      assert.equal(new URL(String(input)).origin, "https://example.com");
      if (method === "GET") {
        if (type === "http") return new Response(null, { status: 405 });
        return new Response(new ReadableStream({
          start(controller) {
            stream = controller;
            controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      const request = JSON.parse(String(init?.body));
      // Real fetch responses expose an empty body stream for HTTP 202, not a
      // null body. The SDK cancels it without reading it after notifications.
      const accepted = () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.close(); },
      }), { status: 202 });
      if (request.id === undefined) return accepted();
      const response = reply(request);
      if (type === "sse") {
        stream.enqueue(encoder.encode(`data: ${JSON.stringify(response)}\n\n`));
        return accepted();
      }
      return Response.json(response);
    } });
  cleanup(t, () => adapter.close());
  const timer = budget([], 2000); cleanup(t, timer.dispose);
  const deadline = Date.now() + 2000;
  await adapter.connect(timer.signal, deadline);
  assert.equal((await adapter.list(undefined, timer.signal, deadline)).tools.length, 1);
  assert.equal((await adapter.call("takeScreenshot", {}, timer.signal, deadline)).isError, true);
  assert.ok(calls.some(c => c.method === "GET"));
  assert.ok(calls.some(c => c.method === "POST"));
  for (const call of calls) {
    assert.equal(call.headers.get("authorization"), "Bearer static");
    assert.equal(call.headers.get("x-key"), "key");
  }
  await adapter.close();
  assert.deepEqual(errors, []);
});

test("401/403 disables without OAuth metadata fetch, browser launch, or retry", async t => {
  for (const type of ["http", "sse"] as const) for (const status of [401, 403]) {
    let requests = 0;
    const errors: { code: string }[] = [];
    const adapter = createAdapter({ type, url: "https://example.com/mcp", headers: {} }, e => errors.push(e), {
      fetch: async () => { requests++; return new Response("private body", { status, headers: { "www-authenticate": 'Bearer resource_metadata="https://secret.example/auth"' } }); },
    });
    cleanup(t, () => adapter.close());
    const timer = budget([], 1000); cleanup(t, timer.dispose);
    await assert.rejects(adapter.connect(timer.signal, Date.now() + 1000));
    assert.equal(requests, 1);
    assert.equal(errors[0].code, "unsupported_auth");
    assert.ok(!JSON.stringify(errors).includes("private"));
  }
});

test("SSE connect abort closes pending endpoint stream; endpoint origin changes are fatal", async t => {
  for (const endpoint of [undefined, "https://elsewhere.example/messages"]) {
    let canceled = false;
    const adapter = createAdapter({ type: "sse", url: "https://example.com/sse", headers: {} }, () => {}, {
      fetch: async () => new Response(new ReadableStream({
        start(controller) { if (endpoint) controller.enqueue(new TextEncoder().encode(`event: endpoint\ndata: ${endpoint}\n\n`)); },
        cancel() { canceled = true; },
      }), { headers: { "content-type": "text/event-stream" } }),
    });
    cleanup(t, () => adapter.close());
    const timer = budget([], 30); cleanup(t, timer.dispose);
    await assert.rejects(adapter.connect(timer.signal, Date.now() + 30));
    await adapter.close();
    // EventSource cancels its reader asynchronously.
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(canceled, true);
  }
});

test("HTTP JSON and SSE limits apply across chunks, but not across events", async () => {
  const response = (parts: string[], sse: boolean, max: number) => new Response(boundedBody(new ReadableStream({
    start(controller) { for (const s of parts) controller.enqueue(new TextEncoder().encode(s)); controller.close(); },
  }), sse, max));
  await assert.rejects(response(["1234", "5678"], false, 7).text(), { code: "result_too_large" });
  await assert.rejects(response(["data:123", "45\n\n"], true, 8).text(), { code: "result_too_large" });
  assert.equal(await response(["data:1\r", "\n\r\n", "data:2\n\n"], true, 10).text(), "data:1\r\n\r\ndata:2\n\n");
});
