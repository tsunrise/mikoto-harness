import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { MikotoPolicyEscalateEvent } from "mikoto-types";
import { EscalationBroker } from "../src/escalate/broker.ts";
import { provideEscalationApi } from "../src/escalate/api.ts";
import { installEscalation } from "../src/escalate/index.ts";
import { harness, request, tick } from "./escalation-fixtures.ts";

describe("escalation broker", () => {
  it("serializes FIFO, retains the reason slot, caps pending at 32, and records plain data", async () => {
    const h = harness();
    const broker = new EscalationBroker(h.pi);
    broker.start(h.ctx);
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
    assert.match(h.dialogs[1]!.render(80).join("\n"), /\/target\/1/);
    assert.equal(sounds, 2);
    h.dialogs[1]!.handleInput("\x1b[D");
    h.dialogs[1]!.handleInput("\r");
    assert.deepEqual(await pending[1], { decision: "approve" });
    broker.invalidate();
    const rest = await Promise.all(pending.slice(2));
    assert.ok(rest.every((result) => result.decision === "reject"));
    assert.equal(h.entries.length, 3); // busy, user rejection, approval; no stale teardown entries.
    assert.doesNotThrow(() => structuredClone(h.entries));
  });

  it("cancels before admission, while queued, and before the component factory", async () => {
    const h = harness();
    const broker = new EscalationBroker(h.pi);
    broker.start(h.ctx);
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
    broker.start(h.ctx);
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
      broker.start({ ...h.ctx, mode, hasUI: mode === "rpc" });
      assert.deepEqual(await broker.request(request()), { decision: "reject", cause: "non_interactive" });
    }
    assert.equal(h.dialogs.length, 0);
    assert.equal(h.entries.length, 0);
  });

  it("abort racing approval cannot approve; history failure denies", async () => {
    const h = harness();
    const broker = new EscalationBroker(h.pi);
    broker.start(h.ctx);
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
    assert.deepEqual(await b, { decision: "reject", cause: "error" });
    log.mock.restore();
  });

  it("drains on shutdown/tree, rejects stale results and lifetime checks, resubscribes once", async () => {
    const h = harness();
    const broker = installEscalation(h.pi);
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
