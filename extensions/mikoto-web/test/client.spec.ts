import assert from "node:assert/strict";
import { test } from "node:test";
import { search, searchSessionId, searchModel, parseResult, readResponse } from "../src/client.ts";
import { errorResponse } from "../src/errors.ts";

const request = () => ({
  sessionId: "session", model: "gpt-active",
  commands: { open: [{ ref_id: "turn0search0", lineno: 0 }], response_length: "short" as const },
  auth: {
    provider: "openai" as const, endpoint: "https://api.openai.com/v1/alpha/search",
    headers: { authorization: "Bearer credential-canary" },
  },
  signal: new AbortController().signal,
});

test("sends only commands/session/model and returns only output plus opaque results", async () => {
  const input = request();
  const output = "citeturn1view0 [wordlim: 200]\nL0: page";
  const results = [{ type: "future_result", arbitrary: { preserved: true }, ref_id: "turn1view0" }];
  const body = await search(input, { fetch: async (url, init) => {
    assert.equal(url, input.auth.endpoint);
    assert.equal(init!.redirect, "error");
    assert.deepEqual(init!.headers, input.auth.headers);
    assert.deepEqual(JSON.parse(init!.body as string), {
      id: searchSessionId("session", "openai"), model: "gpt-active", commands: input.commands,
    });
    return Response.json({ output, results, encrypted_output: "secret", provider: "secret", headers: "secret" });
  } });
  assert.deepEqual(JSON.parse(body), { output, results });
});

test("normalizes optional results but rejects invalid envelopes", () => {
  for (const results of [undefined, null, []]) {
    assert.deepEqual(parseResult(JSON.stringify({ output: "x", results })), { output: "x", results: results ?? null });
  }
  for (const input of ["null", "{}", "[]", "{", '{"output":1}', '{"output":"x","results":{}}']) {
    assert.throws(() => parseResult(input), { code: "invalid_upstream_response" });
  }
});

test("stable provider-separated session IDs and model selection", () => {
  assert.equal(searchSessionId("one", "openai"), searchSessionId("one", "openai"));
  assert.notEqual(searchSessionId("one", "openai"), searchSessionId("two", "openai"));
  assert.notEqual(searchSessionId("one", "openai"), searchSessionId("one", "openai-codex"));
  assert.equal(searchModel(undefined), "gpt-5.4");
  assert.equal(searchModel({ provider: "anthropic", id: "claude" }), "gpt-5.4");
  assert.equal(searchModel({ provider: "openai-codex", id: "gpt-active" }), "gpt-active");
});

test("safe HTTP errors cancel bodies and never retry", async () => {
  for (const [status, code, local] of [
    [401, "upstream_auth_error", 502], [403, "upstream_auth_error", 502],
    [429, "rate_limited", 429], [500, "upstream_error", 502], [302, "upstream_error", 502],
  ] as const) {
    let canceled = false;
    let calls = 0;
    await assert.rejects(search(request(), { fetch: async () => {
      calls++;
      return new Response(new ReadableStream({ cancel() { canceled = true; } }), { status });
    } }), (error: unknown) => {
      const response = errorResponse(error);
      assert.equal(response.status, local);
      assert.equal(JSON.parse(response.body).error.code, code);
      assert.equal(JSON.parse(response.body).error.upstream_status, status);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(canceled, true);
  }
  await assert.rejects(search(request(), { fetch: async () => { throw new Error("credential-canary"); } }),
    (error: unknown) => !errorResponse(error).body.includes("credential-canary"));
});

test("bounded decompressed bytes, fatal UTF-8, outgoing normalization size and cancellation", async () => {
  const signal = new AbortController().signal;
  assert.equal(await readResponse(new Response("éé"), signal, 4), "éé");
  await assert.rejects(readResponse(new Response("ééx"), signal, 4), { code: "response_too_large" });
  await assert.rejects(readResponse(new Response(new Uint8Array([0xff])), signal), { code: "invalid_upstream_response" });
  // Adding normalized results:null can exceed the bound even if input fits.
  await assert.rejects(search(request(), {
    fetch: async () => new Response('{"output":""}'), responseLimit: 13,
  }), { code: "response_too_large" });
  const controller = new AbortController();
  let canceled = false;
  const reading = readResponse(new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([65])); },
    cancel() { canceled = true; },
  })), controller.signal);
  const rejection = assert.rejects(reading, { name: "AbortError" });
  controller.abort();
  await rejection;
  assert.equal(canceled, true);
});

test("timeouts abort transport and body reads; caller abort is not an upstream error", async () => {
  await assert.rejects(search(request(), {
    timeoutMs: 10,
    fetch: async (_url, init) => new Promise((_resolve, reject) =>
      init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
  }), { code: "upstream_timeout" });
  let canceled = false;
  await assert.rejects(search(request(), {
    timeoutMs: 10,
    fetch: async () => new Response(new ReadableStream({ cancel() { canceled = true; } })),
  }), { code: "upstream_timeout" });
  assert.equal(canceled, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(search({ ...request(), signal: controller.signal }, {
    fetch: async () => { assert.fail("must not fetch"); },
  }), { name: "AbortError" });
});
