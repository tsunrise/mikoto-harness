import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, fixture, jwt } from "./fixtures.ts";

test("registers once without credentials; startup and shutdown perform no auth work", async () => {
  const h = fixture();
  h.configured.clear();
  const [tool] = h.tools;
  assert.equal(tool.exposure, "deferred");
  await h.start();
  await assert.rejects(h.call(), { code: "auth_unavailable" });
  await h.start();
  assert.deepEqual(h.tools, [tool]);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.notices, []);
  h.configured.add("openai-codex");
  assert.deepEqual((await h.call()).structuredContent, { output: "test", results: [], truncated: false });
  h.stop();
  h.stop();
  await assert.rejects(h.call());
});

test("refreshes auth per call, supports Claude and Workers AI, and separates provider sessions", async () => {
  const sent: { url: unknown; body: any }[] = [];
  const h = fixture({ fetch: async (url, init) => {
    sent.push({ url, body: JSON.parse(init!.body as string) });
    return Response.json({ output: "value", results: [], encrypted_output: "internal" });
  } });
  await h.start();
  await h.call();
  h.model("openai-codex", "gpt-next");
  await h.call();
  h.model("anthropic", "claude-opus-5-5");
  await h.call();
  h.model("cloudflare-workers-ai", "@zai-org/glm-5.3");
  await h.call();
  assert.deepEqual(sent.map((s) => s.body.model), ["gpt-5.4", "gpt-next", "gpt-5.4", "gpt-5.4"]);
  assert.equal(new Set(sent.map((s) => s.body.id)).size, 1);
  h.configured.delete("openai-codex");
  await h.call();
  assert.equal(sent[4].url, "https://api.openai.com/v1/alpha/search");
  assert.notEqual(sent[0].body.id, sent[4].body.id);
  assert.deepEqual(h.calls, ["openai-codex", "openai-codex", "openai-codex", "openai-codex", "openai"]);
  h.stop();
});

test("shutdown during auth resolution cannot fetch late", async () => {
  const h = fixture({ fetch: async () => { assert.fail("must not fetch"); } });
  const gate = deferred<{ auth: { apiKey: string } }>();
  h.auth.getProviderAuth = () => gate.promise;
  await h.start();
  const rejected = assert.rejects(h.call(), { name: "AbortError" });
  h.stop();
  gate.resolve({ auth: { apiKey: jwt() } });
  await rejected;
});

test("cancellation during shared auth retains capacity until auth settles", async () => {
  let fetched = 0;
  const h = fixture({ fetch: async () => { fetched++; return Response.json({ output: "x" }); } });
  await h.start();
  const gate = deferred<{ auth: { apiKey: string } }>();
  h.auth.getProviderAuth = () => gate.promise;
  const controller = new AbortController();
  const rejection = assert.rejects(h.call(controller.signal), { name: "AbortError" });
  const two = h.call();
  controller.abort();
  await assert.rejects(h.call(), { code: "rate_limited" });
  gate.resolve({ auth: { apiKey: jwt() } });
  await rejection;
  await two;
  assert.equal(fetched, 1);
  await h.call();
  assert.equal(fetched, 2);
  h.stop();
});

test("tree navigation, session replacement and shutdown abort in-flight requests", async () => {
  let entered = deferred<void>();
  const h = fixture({ fetch: async (_url, init) => {
    entered.resolve();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort",
      () => reject(new Error("transport abort")), { once: true }));
  } });
  await h.start();
  for (const retire of [h.tree, h.start, h.stop]) {
    entered = deferred<void>();
    const rejected = assert.rejects(h.call(), { name: "AbortError" });
    await entered.promise;
    await retire();
    await rejected;
  }
  assert.equal(h.tools.length, 1);
});

test("input validation runs before auth or fetch, including after hook edits", async () => {
  const h = fixture({ fetch: async () => { assert.fail("must not fetch"); } });
  await h.start();
  for (const args of [
    {}, { search_query: [] }, { open: [{ ref_id: "file:///etc/passwd" }] },
    { search_query: [{ q: "test" }], extra: true },
    { search_query: Array.from({ length: 5 }, () => ({ q: "x".repeat(4096) })) },
  ]) {
    await assert.rejects(h.call(undefined, args));
  }
  assert.deepEqual(h.calls, []);
  h.stop();
});

test("normalizes inputs and never falls back to API billing on subscription failure", async () => {
  const h = fixture({ fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    assert.equal(body.commands.response_length, "medium");
    assert.deepEqual(body.commands.search_query[0].domains, ["xn--bcher-kva.example"]);
    return new Response("secret", { status: 403 });
  } });
  await h.start();
  await assert.rejects(h.call(undefined, {
    search_query: [{ q: "test", domains: ["Bücher.example"] }],
  }), { code: "upstream_auth_error" });
  assert.deepEqual(h.calls, ["openai-codex"]);
  h.stop();
});
