import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthResolver } from "../src/auth.ts";
import { registry, jwt, deferred } from "./fixtures.ts";

const signal = () => new AbortController().signal;

test("prefers Codex, ignores provider redirects/headers, and resolves afresh", async () => {
  const h = registry();
  const original = h.auth.getProviderAuth;
  h.auth.getProviderAuth = async (provider) => {
    const result = await original(provider);
    return { auth: { ...result!.auth, baseUrl: "https://credential-thief.invalid", headers: { secret: "canary" } } };
  };
  const resolve = createAuthResolver(h.auth);
  for (let n = 0; n < 2; n++) {
    const result = await resolve(signal());
    assert.equal(result.provider, "openai-codex");
    assert.equal(result.endpoint, "https://chatgpt.com/backend-api/codex/alpha/search");
    assert.equal(result.headers.authorization, `Bearer ${jwt()}`);
    assert.equal(result.headers["chatgpt-account-id"], "account-canary");
    assert.equal(result.headers.secret, undefined);
  }
  assert.deepEqual(h.calls, ["openai-codex", "openai-codex"]);
});

test("API-only resolution preserves only organization/project headers and follows auth changes", async () => {
  const h = registry();
  h.configured.delete("openai-codex");
  h.auth.getProviderAuth = async () => ({
    auth: { apiKey: "environment-key", headers: {
      "OpenAI-Organization": "org", "openai-project": "project", authorization: "wrong",
      "x-secret": "canary",
    } },
    source: "OPENAI_API_KEY",
  });
  const resolve = createAuthResolver(h.auth);
  const result = await resolve(signal());
  assert.equal(result.endpoint, "https://api.openai.com/v1/alpha/search");
  assert.equal(result.headers.authorization, "Bearer environment-key");
  assert.equal(result.headers["openai-organization"], "org");
  assert.equal(result.headers["openai-project"], "project");
  assert.equal(result.headers["x-secret"], undefined);
  h.configured.clear();
  await assert.rejects(resolve(signal()), { code: "auth_unavailable" });
});

test("subscription failure is never absence or an API fallback", async () => {
  for (const value of [undefined, { auth: { apiKey: "" } }, { auth: { apiKey: "bad-jwt" } },
    { auth: { apiKey: jwt("") } }, { auth: { apiKey: jwt("x\r\nsecret") } }]) {
    const h = registry();
    const calls: string[] = [];
    h.auth.getProviderAuth = async (provider) => { calls.push(provider); return value; };
    await assert.rejects(createAuthResolver(h.auth)(signal()), { code: "auth_unavailable" });
    assert.deepEqual(calls, ["openai-codex"]);
  }
  const h = registry();
  h.auth.getProviderAuth = async () => { throw new Error("credential-canary"); };
  await assert.rejects(createAuthResolver(h.auth)(signal()), (error: Error) =>
    !error.message.includes("credential-canary"));
});

test("single-flights shared refresh and waits for it to settle after caller cancellation", async () => {
  const h = registry();
  const gate = deferred<{ auth: { apiKey: string } }>();
  let calls = 0;
  h.auth.getProviderAuth = () => { calls++; return gate.promise; };
  const resolve = createAuthResolver(h.auth);
  const controller = new AbortController();
  const one = resolve(controller.signal);
  const rejection = assert.rejects(one, { name: "AbortError" });
  const two = resolve(signal());
  controller.abort();
  assert.equal(calls, 1);
  gate.resolve({ auth: { apiKey: jwt() } });
  await rejection;
  assert.equal((await two).provider, "openai-codex");
  await resolve(signal());
  assert.equal(calls, 2);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(resolve(stopped.signal));
  assert.equal(calls, 2);
});
