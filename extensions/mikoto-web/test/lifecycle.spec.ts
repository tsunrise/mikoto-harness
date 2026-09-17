import assert from "node:assert/strict";
import { test } from "node:test";
import type { MikotoGardenBindResult, MikotoEventEmitter } from "mikoto-types";
import { z } from "zod";
import { bind } from "../src/bind.ts";
import { call, deferred, fixture, jwt } from "./fixtures.ts";

test("binds only with usable credentials and disposes on repeated lifecycle events", async () => {
  const h = fixture();
  await h.start();
  assert.equal(h.bindings.length, 1);
  assert.equal(h.bindings[0].path, "/web/run");
  assert.equal(h.bindings[0].method, "POST");
  assert.equal(h.notices.length, 0);
  await h.start();
  assert.deepEqual(h.disposed, [1]);
  h.stop();
  h.stop();
  assert.deepEqual(h.disposed, [1, 2]);
  const empty = fixture();
  empty.configured.clear();
  await empty.start();
  assert.equal(empty.bindings.length, 0);
  assert.equal(empty.notices.length, 1);
  const bad = fixture();
  bad.auth.getProviderAuth = async () => { throw new Error("secret"); };
  await bad.start();
  assert.equal(bad.bindings.length, 0);
  assert.ok(!JSON.stringify(bad.notices).includes("secret"));
  const api = fixture();
  api.configured.delete("openai-codex");
  await api.start();
  assert.deepEqual(api.calls, ["openai"]);
  api.stop();
});

test("refreshes auth per request, follows active model and separates provider sessions", async () => {
  const sent: { url: unknown; body: any }[] = [];
  const h = fixture({ fetch: async (url, init) => {
    sent.push({ url, body: JSON.parse(init!.body as string) });
    return Response.json({ output: "value", results: [], provider: "internal", model: "internal" });
  } });
  await h.start();
  assert.deepEqual(JSON.parse((await call(h.bindings[0])).body!), { output: "value", results: [] });
  h.model("openai-codex", "gpt-next");
  await call(h.bindings[0]);
  h.model("anthropic", "claude");
  await call(h.bindings[0]);
  assert.deepEqual(sent.map((s) => s.body.model), ["gpt-5.4", "gpt-next", "gpt-5.4"]);
  assert.equal(new Set(sent.map((s) => s.body.id)).size, 1);
  h.configured.delete("openai-codex");
  await call(h.bindings[0]);
  assert.equal(sent[3].url, "https://api.openai.com/v1/alpha/search");
  assert.notEqual(sent[0].body.id, sent[3].body.id);
  h.configured.clear();
  assert.equal((await call(h.bindings[0])).status, 503);
  assert.equal(sent.length, 4);
  h.stop();
});

test("shutdown during auth resolution cannot bind or fetch late", async () => {
  const h = fixture();
  const gate = deferred<{ auth: { apiKey: string } }>();
  h.auth.getProviderAuth = () => gate.promise;
  const starting = h.start();
  h.stop();
  gate.resolve({ auth: { apiKey: jwt() } });
  await starting;
  assert.equal(h.bindings.length, 0);
  assert.equal(h.notices.length, 0);
});

test("cancellation during shared auth retains capacity until auth settles", async () => {
  let fetched = 0;
  const h = fixture({ fetch: async () => { fetched++; return Response.json({ output: "x" }); } });
  await h.start();
  const gate = deferred<{ auth: { apiKey: string } }>();
  h.auth.getProviderAuth = () => gate.promise;
  const controller = new AbortController();
  const one = call(h.bindings[0], controller.signal);
  const rejection = assert.rejects(one, { name: "AbortError" });
  const two = call(h.bindings[0]);
  controller.abort();
  assert.equal((await call(h.bindings[0])).status, 429);
  gate.resolve({ auth: { apiKey: jwt() } });
  await rejection;
  assert.equal((await two).status, 200);
  assert.equal(fetched, 1);
  assert.equal((await call(h.bindings[0])).status, 200);
  h.stop();
});

test("tree navigation and shutdown abort in-flight requests without stale reuse", async () => {
  let entered = deferred<void>();
  const h = fixture({ fetch: async (_url, init) => {
    entered.resolve();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort",
      () => reject(new Error("transport abort")), { once: true }));
  } });
  await h.start();
  const one = call(h.bindings[0]);
  const rejectedOne = assert.rejects(one, { name: "AbortError" });
  await entered.promise;
  h.tree();
  await rejectedOne;
  assert.equal(h.disposed.length, 0);
  entered = deferred<void>();
  const two = call(h.bindings[0]);
  const rejectedTwo = assert.rejects(two, { name: "AbortError" });
  await entered.promise;
  h.stop();
  await rejectedTwo;
  assert.deepEqual(h.disposed, [1]);
});

test("missing/rejected Garden emits only a safe availability notice", async () => {
  for (const emit of [
    () => {},
    (event: Parameters<NonNullable<NonNullable<Parameters<typeof fixture>[0]>["emit"]>>[0]) =>
      event.callback?.({ ok: false, reason: "sensitive-detail" }),
  ]) {
    const h = fixture({ emit });
    await h.start();
    assert.equal(h.notices.length, 1);
    assert.ok(!JSON.stringify(h.notices).includes("sensitive-detail"));
    h.stop();
  }
});

test("binding acknowledgements: duplicates, late callbacks, abort, and acknowledge-then-throw", async () => {
  const event = {
    owner: "test", method: "GET" as const, path: "/test" as const,
    bodySchema: z.undefined(), async handler() { return { status: 204 }; },
  };
  for (const scenario of ["duplicate", "late", "throw", "abort"] as const) {
    let callback!: (result: MikotoGardenBindResult) => void;
    let firstDisposed = 0;
    let secondDisposed = 0;
    const controller = new AbortController();
    const first = { ok: true as const, bindingId: "one", dispose: () => { firstDisposed++; } };
    const second = { ok: true as const, bindingId: "two", dispose: () => { secondDisposed++; } };
    const events = { emit(_name: string, payload: any) {
      callback = payload.callback;
      if (scenario === "late") return;
      callback(first);
      if (scenario === "throw") throw new Error("secret");
      if (scenario === "abort") controller.abort();
      if (scenario === "duplicate") { callback(first); callback(second); }
    } } as MikotoEventEmitter;
    const dispose = await bind(events, event, controller.signal, 5);
    if (scenario === "duplicate") {
      assert.ok(dispose);
      assert.equal(firstDisposed, 0);
      assert.equal(secondDisposed, 1);
      callback(first);
      assert.equal(firstDisposed, 0);
      dispose();
    } else {
      assert.equal(dispose, undefined);
      if (scenario === "late") callback(first);
    }
    assert.equal(firstDisposed, 1);
  }
});
