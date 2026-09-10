import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MikotoGardenBindEvent } from "mikoto-types";
import terminalNotify from "../index.ts";

type Handler = (...args: unknown[]) => unknown;

function fixture(
  hasUI = true,
  acknowledgement: "success" | "failure" | "none" = "success",
) {
  const handlers = new Map<string, Handler>();
  const notices: { text: string; type: string }[] = [];
  let binding: MikotoGardenBindEvent<string> | undefined;
  let primaryDisposed = false;
  let duplicateDisposed = false;
  const pi = {
    events: {
      emit(name: string, data: unknown) {
        assert.equal(name, "mikoto-garden:bind");
        binding = data as MikotoGardenBindEvent<string>;
        if (acknowledgement === "none") return;
        if (acknowledgement === "failure") {
          binding.callback?.({ ok: false, reason: "Route already bound" });
          return;
        }
        binding.callback?.({
          ok: true,
          bindingId: "primary",
          dispose() {
            primaryDisposed = true;
          },
        });
        binding.callback?.({
          ok: true,
          bindingId: "duplicate",
          dispose() {
            duplicateDisposed = true;
          },
        });
      },
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  terminalNotify(pi);
  const ctx = {
    hasUI,
    ui: {
      notify(text: string, type: string) {
        notices.push({ text, type });
      },
    },
  } as unknown as ExtensionContext;
  handlers.get("session_start")!({}, ctx);
  assert.ok(binding);
  return {
    binding,
    handlers,
    notices,
    primaryDisposed: () => primaryDisposed,
    duplicateDisposed: () => duplicateDisposed,
  };
}

function request(binding: MikotoGardenBindEvent<string>, body: string) {
  return binding.handler({
    method: "POST",
    path: "/update",
    headers: {},
    body,
    signal: new AbortController().signal,
  });
}

test("binds one notification route, sanitizes UI text and disposes duplicate bindings", async () => {
  const h = fixture();
  assert.equal(h.binding.method, "POST");
  assert.equal(h.binding.path, "/update");
  assert.equal(h.binding.bodyFormat, "text");
  assert.equal(h.duplicateDisposed(), true);
  assert.equal(h.primaryDisposed(), false);
  assert.equal(
    (await request(h.binding, "safe\u001b]52;c;secret\u0007tail\u001b[31m")).status,
    204,
  );
  assert.deepEqual(h.notices, [{ text: "safetail", type: "info" }]);
  h.handlers.get("session_shutdown")!({}, {});
  assert.equal(h.primaryDisposed(), true);
});

test("reports missing and rejected binding acknowledgements", () => {
  assert.deepEqual(fixture(true, "none").notices, [{
    text: "Terminal notification capability unavailable",
    type: "warning",
  }]);
  assert.deepEqual(fixture(true, "failure").notices, [{
    text: "Terminal notification capability unavailable: Route already bound",
    type: "warning",
  }]);
});

test("bounds messages, rate limits requests and rejects unavailable UI", async () => {
  const h = fixture();
  assert.equal((await h.binding.bodySchema.safeParseAsync("x".repeat(16 * 1024))).success, true);
  assert.equal(
    (await h.binding.bodySchema.safeParseAsync("x".repeat(16 * 1024 + 1))).success,
    false,
  );
  const responses = await Promise.all(
    Array.from({ length: 11 }, (_, index) => request(h.binding, String(index))),
  );
  assert.deepEqual(
    responses.map((response) => response.status),
    [...Array.from({ length: 10 }, () => 204), 429],
  );
  const unavailable = fixture(false);
  assert.deepEqual(await request(unavailable.binding, "message"), {
    status: 503,
    body: "UI unavailable",
  });
  assert.deepEqual(unavailable.notices, []);
});
