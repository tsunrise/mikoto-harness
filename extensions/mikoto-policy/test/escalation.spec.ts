import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { MikotoPolicyEscalateEvent } from "mikoto-types";
import { EscalationBroker } from "../src/escalate/broker.ts";
import { provideEscalationApi } from "../src/escalate/api.ts";
import { installEscalation } from "../src/escalate/index.ts";
import { harness, request, tick, loaded, loader } from "./escalation-fixtures.ts";
import type { MikotoEscalationResult } from "mikoto-types";
import { DEADLINE_MS } from "../src/escalate/auto-review/model.ts";

describe("escalation broker", () => {
  it("times out an uncooperative injected backend and releases the active slot", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = harness();
    let calls = 0;
    const broker = new EscalationBroker(h.pi, async () => {
      if (++calls === 1) return new Promise(() => {});
      return { decision: "approve" };
    });
    broker.start(h.ctx, { ...loaded, settings: { ...loaded.settings, escalation: "auto-review" } });
    const first = broker.request(request("first"));
    const second = broker.request(request("second"));
    t.mock.timers.tick(DEADLINE_MS);
    assert.deepEqual(await first, { decision: "reject", cause: "error" });
    assert.deepEqual(await second, { decision: "approve" });
  });

  it("routes every mode without reviewer UI, sounds, history, or parent interruption", async () => {
    for (const mode of ["tui", "print", "json", "rpc"] as const) {
      for (const hasUI of [true, false]) {
        for (const escalation of ["ask-me", "auto-review", "always-deny"] as const) {
          const h = harness();
          let calls = 0;
          let sounds = 0;
          h.bus.on("mikoto-sound:sound", () => sounds++);
          const backend = async () => { calls++; return { decision: "approve" } as const; };
          const broker = new EscalationBroker(h.pi, backend);
          broker.start({ ...h.ctx, mode, hasUI }, { ...loaded, settings: { ...loaded.settings, escalation } });
          const result = broker.request(request());
          if (escalation === "ask-me" && mode === "tui" && hasUI) {
            await tick();
            h.dialogs[0]!.handleInput("\x1b[D");
            h.dialogs[0]!.handleInput("\r");
          }
          const settled = await result;
          assert.equal(calls, escalation === "auto-review" ? 1 : 0);
          assert.equal(h.dialogs.length, escalation === "ask-me" && mode === "tui" && hasUI ? 1 : 0);
          assert.equal(sounds, h.dialogs.length);
          assert.equal(h.entries.length, 0);
          assert.equal(h.interrupted, 0);
          if (escalation === "always-deny") {
            assert.equal(settled.decision, "reject");
            assert.equal(settled.decision === "reject" && settled.cause, "user");
          }
        }
      }
    }
  });

  it("freezes nested admission snapshots, FIFO and queued cancellation; detaches ignored abort", async () => {
    const h = harness();
    const seen: unknown[] = [];
    let finish!: (result: MikotoEscalationResult) => void;
    const broker = new EscalationBroker(h.pi, async (request) => {
      seen.push(request.action);
      assert.ok(Object.isFrozen(request.action.input));
      if (seen.length === 1) return new Promise((resolve) => { finish = resolve; });
      return { decision: "approve" };
    });
    broker.start(h.ctx, { ...loaded, settings: { ...loaded.settings, escalation: "auto-review" } });
    const abort = new AbortController();
    const first = broker.request(request("first", abort.signal));
    const nested = { target: { path: "/approved" } };
    const second = broker.request({ ...request("second"), action: { toolName: "unfamiliar-operation", input: nested } });
    nested.target.path = "/changed";
    abort.abort();
    assert.deepEqual(await first, { decision: "reject", cause: "cancelled" });
    assert.deepEqual(await second, { decision: "approve" });
    assert.deepEqual(seen[1], { toolName: "unfamiliar-operation", input: { target: { path: "/approved" } } });
    finish({ decision: "approve" });
    await tick();
    assert.equal(h.entries.length, 0);
    assert.equal(h.dialogs.length, 0);
  });

  it("does not call even an injected reviewer on failed policy loading", async () => {
    const h = harness();
    const broker = new EscalationBroker(h.pi, async () => assert.fail("invalid policy"));
    broker.start(h.ctx, { ...loaded, settings: { ...loaded.settings, escalation: "auto-review" },
      diagnostics: [{ kind: "invalid_layer", path: "/private-config" }] });
    assert.deepEqual(await broker.request(request()), { decision: "reject", cause: "error" });
  });

  it("simplified manual dialog omits all caller data except tool name", async () => {
    const h = harness();
    const broker = new EscalationBroker(h.pi);
    broker.start(h.ctx, loaded);
    const pending = broker.request({ ...request(), source: "private-source", why: "private-justification",
      action: { toolName: "public-name", input: "private-input", context: "private-context" } });
    await tick();
    const text = h.dialogs[0]!.render(80).join("\n");
    assert.ok(text.includes("public-name"));
    assert.doesNotMatch(text, /private-/);
    broker.invalidate();
    await pending;
  });

  it("serializes FIFO, retains the reason slot, caps pending at 32, and writes no history", async () => {
    const h = harness();
    const broker = new EscalationBroker(h.pi);
    broker.start(h.ctx, loaded);
    let sounds = 0;
    h.bus.on("mikoto-sound:sound", () => sounds++);
    const pending = Array.from({ length: 32 }, (_, i) => broker.request(request(String(i))));
    assert.deepEqual(await broker.request(request("busy")), { decision: "reject", cause: "busy" });
    await tick();
    assert.equal(h.dialogs.length, 1);
    assert.equal(sounds, 1);
    h.dialogs[0]!.handleInput("\r"); // Reject is the default.
    await tick();
    assert.equal(h.dialogs.length, 1);
    h.dialogs[0]!.handleInput("Please keep this private");
    h.dialogs[0]!.handleInput("\r");
    assert.deepEqual(await pending[0], { decision: "reject", cause: "user", reason: "Please keep this private" });
    await tick();
    assert.match(h.dialogs[1]!.render(80).join("\n"), /write-1/);
    assert.equal(sounds, 2);
    h.dialogs[1]!.handleInput("\x1b[D");
    h.dialogs[1]!.handleInput("\r");
    assert.deepEqual(await pending[1], { decision: "approve" });
    broker.invalidate();
    const rest = await Promise.all(pending.slice(2));
    assert.ok(rest.every((result) => result.decision === "reject"));
    assert.equal(h.entries.length, 0);
    assert.doesNotThrow(() => structuredClone(h.entries));
  });

  it("cancels before admission, while queued, and before the component factory", async () => {
    const h = harness();
    const broker = new EscalationBroker(h.pi);
    broker.start(h.ctx, loaded);
    const aborted = AbortSignal.abort();
    assert.deepEqual(await broker.request(request("early", aborted)), { decision: "reject", cause: "cancelled" });
    let release!: () => void;
    const gate = { promise: new Promise<void>((resolve) => { release = resolve; }) };
    h.delayFactory(() => gate.promise);
    const first = new AbortController();
    const second = new AbortController();
    const a = broker.request(request("a", first.signal));
    const b = broker.request(request("b", second.signal));
    second.abort();
    first.abort();
    assert.deepEqual(await a, { decision: "reject", cause: "cancelled" });
    assert.deepEqual(await b, { decision: "reject", cause: "cancelled" });
    release();
    await tick();
    assert.equal(h.dialogs.length, 1);
    const third = broker.request(request("c"));
    await tick();
    assert.equal(h.dialogs.length, 2);
    h.dialogs[1]!.handleInput("\x1b");
    assert.deepEqual(await third, { decision: "reject", cause: "interrupted" });
  });

  it("decision Escape interrupts siblings, but reason Escape keeps the active request and queue pending", async () => {
    const h = harness();
    const broker = new EscalationBroker(h.pi);
    broker.start(h.ctx, loaded);
    const a = broker.request(request());
    const b = broker.request(request("b"));
    await tick();
    h.dialogs[0]!.handleInput("\x1b");
    assert.deepEqual(await a, { decision: "reject", cause: "interrupted" });
    assert.deepEqual(await b, { decision: "reject", cause: "interrupted" });
    assert.equal(h.interrupted, 1);
    const c = broker.request(request("c"));
    const d = broker.request(request("d"));
    let settled = false;
    void c.then(() => { settled = true; });
    await tick();
    const entriesBeforeBack = h.entries.length;
    h.dialogs[1]!.handleInput("\r");
    h.dialogs[1]!.handleInput("\x1b");
    await tick();
    assert.equal(settled, false);
    assert.equal(h.entries.length, entriesBeforeBack);
    assert.equal(h.dialogs.length, 2);
    assert.equal(h.interrupted, 1);
    h.dialogs[1]!.handleInput("\x1b[D");
    h.dialogs[1]!.handleInput("\r");
    assert.deepEqual(await c, { decision: "approve" });
    await tick();
    assert.equal(h.dialogs.length, 3);
    h.dialogs[2]!.handleInput("\r");
    h.dialogs[2]!.handleInput("\r");
    assert.deepEqual(await d, { decision: "reject", cause: "user" });
    assert.equal(h.interrupted, 1);
  });

  it("fails closed in every non-TUI mode and without UI", async () => {
    const h = harness();
    const broker = new EscalationBroker(h.pi);
    assert.deepEqual(await broker.request(request()), { decision: "reject", cause: "unavailable" });
    for (const mode of ["rpc", "print", "json", "tui"] as const) {
      broker.start({ ...h.ctx, mode, hasUI: mode === "rpc" }, loaded);
      assert.deepEqual(await broker.request(request()), { decision: "reject", cause: "non_interactive" });
    }
    assert.equal(h.dialogs.length, 0);
    assert.equal(h.entries.length, 0);
  });

  it("abort racing approval cannot approve; settlement never writes history", async () => {
    const h = harness();
    const broker = new EscalationBroker(h.pi);
    broker.start(h.ctx, loaded);
    const controller = new AbortController();
    const a = broker.request(request("a", controller.signal));
    await tick();
    h.dialogs[0]!.handleInput("\x1b[D");
    h.dialogs[0]!.handleInput("\r");
    controller.abort();
    assert.deepEqual(await a, { decision: "reject", cause: "cancelled" });
    mock.method(h.pi, "appendEntry", () => { throw new Error("disk full"); });
    const log = mock.method(console, "error", () => {});
    const b = broker.request(request("b"));
    await tick();
    h.dialogs[1]!.handleInput("\x1b[D");
    h.dialogs[1]!.handleInput("\r");
    assert.deepEqual(await b, { decision: "approve" });
    log.mock.restore();
  });

  it("drains on shutdown/tree, rejects stale results and lifetime checks, resubscribes once", async () => {
    const h = harness();
    const broker = installEscalation(h.pi, loader);
    await h.emit("session_start");
    const check = broker.lifetime();
    const a = broker.request(request());
    await tick();
    await h.emit("session_tree");
    assert.throws(check, /runtime changed/);
    assert.deepEqual(await a, { decision: "reject", cause: "shutdown" });
    h.dialogs[0]!.handleInput("\x1b[D");
    h.dialogs[0]!.handleInput("\r");
    assert.equal(h.entries.length, 0);
    await h.emit("session_shutdown");
    assert.equal(h.bus.listenerCount("mikoto-policy:escalate"), 0);
    await h.emit("session_start");
    assert.equal(h.bus.listenerCount("mikoto-policy:escalate"), 1);
  });

  it("claims synchronously, ignores duplicate listeners and catches callback failures", async () => {
    const h = harness();
    const broker = new EscalationBroker(h.pi);
    provideEscalationApi(h.pi, broker);
    provideEscalationApi(h.pi, broker);
    const log = mock.method(console, "error", () => {});
    for (const asyncFailure of [false, true]) {
      let claimed = false;
      let callbacks = 0;
      const event: MikotoPolicyEscalateEvent = {
        ...request(),
        claim: () => { if (claimed) return false; claimed = true; return true; },
        callback(result) {
          callbacks++;
          assert.deepEqual(result, { decision: "reject", cause: "unavailable" });
          if (asyncFailure) return Promise.reject(new Error("async callback"));
          throw new Error("sync callback");
        },
      };
      h.bus.emit("mikoto-policy:escalate", event);
      assert.equal(claimed, true);
      await tick();
      assert.equal(callbacks, 1);
    }
    assert.equal(log.mock.callCount(), 2);
    log.mock.restore();
  });
});
