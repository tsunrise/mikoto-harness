import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MikotoEventEmitter, MikotoPolicy, MikotoPolicyEscalateEvent } from "mikoto-types";
import { installApplyPatchPolicy, requestEscalation } from "../src/policy.ts";
import { createApplyPatchTool } from "../src/tool.ts";

const request = (signal = new AbortController().signal) => ({
  requestId: "patch-1", source: "Test", verb: "Apply Patch",
  subject: ["/a", "/b"], why: "Needed", signal,
});

function harness(evaluateWrite?: MikotoPolicy["evaluateWrite"]) {
  const bus = new EventEmitter();
  const handlers = new Map<string, () => void>();
  const events: MikotoEventEmitter = { emit(name: string, data: unknown) { bus.emit(name, data); } };
  const pi = {
    events,
    on(name: string, handler: () => void) { handlers.set(name, handler); },
  } as unknown as ExtensionAPI;
  const evaluated: string[] = [];
  if (evaluateWrite) {
    bus.on("mikoto-policy:get-policy", (event) => event.callback({
      permissionMdPath: "/policy/PERMISSION.md",
      async evaluateWrite(path: string) {
        evaluated.push(path);
        return evaluateWrite(path);
      },
    }));
  }
  const guard = installApplyPatchPolicy(pi);
  handlers.get("session_start")!();
  return { bus, events, guard, evaluated, handlers };
}

describe("claimed escalation delivery", () => {
  it("returns unavailable immediately with no receiver, and ignores late claims", async () => {
    let late: MikotoPolicyEscalateEvent | undefined;
    const h = harness();
    h.bus.on("mikoto-policy:escalate", (event) => { late = event; });
    assert.deepEqual(await requestEscalation(h.events, request()), { decision: "reject", cause: "unavailable" });
    assert.equal(late!.claim(), false);
    late!.callback({ decision: "approve" });
  });

  it("only the first receiver claims and the first callback settles", async () => {
    const h = harness();
    let shown = 0;
    for (let i = 0; i < 3; i++) h.bus.on("mikoto-policy:escalate", (event: MikotoPolicyEscalateEvent) => {
      if (!event.claim()) return;
      shown++;
      event.callback({ decision: "reject", cause: "user", reason: "No thanks" });
      event.callback({ decision: "approve" });
    });
    assert.deepEqual(await requestEscalation(h.events, request()),
      { decision: "reject", cause: "user", reason: "No thanks" });
    assert.equal(shown, 1);
  });

  it("handles sender abort before emission and after claim, discarding late approval", async () => {
    const h = harness();
    let event: MikotoPolicyEscalateEvent | undefined;
    h.bus.on("mikoto-policy:escalate", (data: MikotoPolicyEscalateEvent) => { data.claim(); event = data; });
    assert.deepEqual(await requestEscalation(h.events, request(AbortSignal.abort())),
      { decision: "reject", cause: "cancelled" });
    assert.equal(event, undefined);
    const controller = new AbortController();
    const pending = requestEscalation(h.events, request(controller.signal));
    controller.abort();
    event!.callback({ decision: "approve" });
    assert.deepEqual(await pending, { decision: "reject", cause: "cancelled" });
  });

  it("fails closed on synchronous delivery failure", async () => {
    const log = mock.method(console, "error", () => {});
    const events: MikotoEventEmitter = { emit() { throw new Error("bus failed"); } };
    assert.deepEqual(await requestEscalation(events, request()), { decision: "reject", cause: "error" });
    const h = harness();
    h.bus.on("mikoto-policy:escalate", (event: MikotoPolicyEscalateEvent) => {
      event.claim();
      event.callback({ decision: "approve" });
      throw new Error("failure after synchronous callback");
    });
    assert.deepEqual(await requestEscalation(h.events, request()), { decision: "reject", cause: "error" });
    assert.equal(log.mock.callCount(), 2);
    log.mock.restore();
  });
});

describe("whole prepared patch authorization", () => {
  it("evaluates every distinct target and displays the complete scope in one request", async () => {
    const h = harness(async (path) => path === "/allowed"
      ? { allowed: true } : { allowed: false, deniedPath: path });
    let prompts = 0;
    h.bus.on("mikoto-policy:escalate", (event: MikotoPolicyEscalateEvent) => {
      assert.equal(event.claim(), true);
      prompts++;
      assert.deepEqual(h.evaluated, ["/source", "/allowed", "/destination"]);
      assert.deepEqual(event.subject, ["[denied] /source", "[allowed] /allowed", "[denied] /destination"]);
      assert.match(event.why, /current policy/);
      event.callback({ decision: "approve" });
    });
    await h.guard.assertCanWrite(["/source", "/allowed", "/source", "/destination"], "move");
    assert.equal(prompts, 1);
  });

  it("does not prompt on allowed targets, or on evaluation errors after a denial", async () => {
    const allowed = harness(async () => ({ allowed: true }));
    allowed.bus.on("mikoto-policy:escalate", () => assert.fail("unexpected prompt"));
    await allowed.guard.assertCanWrite(["/a"]);
    const error = harness(async (path) => {
      if (path === "/b") throw new Error("evaluation failure");
      return { allowed: false, deniedPath: path };
    });
    error.bus.on("mikoto-policy:escalate", () => assert.fail("unexpected prompt"));
    await assert.rejects(error.guard.assertCanWrite(["/a", "/b"]), /could not evaluate.*access denied/);
  });

  it("denies unavailable brokers after policy discovery and cancels on runtime replacement", async () => {
    const h = harness(async (path) => ({ allowed: false, deniedPath: path }));
    await assert.rejects(h.guard.assertCanWrite(["/a"]), /unavailable/);
    let received!: () => void;
    const admitted = new Promise<void>((resolve) => { received = resolve; });
    let pendingEvent: MikotoPolicyEscalateEvent | undefined;
    h.bus.on("mikoto-policy:escalate", (event: MikotoPolicyEscalateEvent) => {
      event.claim(); pendingEvent = event; received();
    });
    const pending = h.guard.assertCanWrite(["/a"]);
    await admitted;
    h.handlers.get("session_tree")!();
    pendingEvent!.callback({ decision: "approve" });
    await assert.rejects(pending, /cancelled/);
  });

  it("returns a lifetime check that prevents commit after authorization settles into a stale runtime", async () => {
    const h = harness(async () => ({ allowed: true }));
    const assertCurrent = await h.guard.assertCanWrite(["/a"]);
    assert.ok(assertCurrent);
    assertCurrent();
    h.handlers.get("session_shutdown")!();
    assert.throws(assertCurrent, /abort/i);
  });

  it("keeps raw grammar, both move paths, exact success output, and preparation-before-planning", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "mikoto-patch-escalation-")));
    try {
      const source = join(cwd, "source");
      const destination = join(cwd, "destination");
      await writeFile(source, "old\n");
      const h = harness(async (path) => ({ allowed: false, deniedPath: path }));
      const tool = createApplyPatchTool(h.guard);
      const ctx = { cwd, model: {
        api: "openai-responses", compat: { supportsOpenAIGrammarTools: true },
      } } as unknown as ExtensionContext;
      const patch = "*** Begin Patch\n*** Update File: source\n*** Move to: destination\n@@\n-old\n+new\n*** End Patch";
      let approve = false;
      h.bus.on("mikoto-policy:escalate", (event: MikotoPolicyEscalateEvent) => {
        event.claim();
        assert.deepEqual(new Set(event.subject), new Set([`[denied] ${source}`, `[denied] ${destination}`]));
        event.callback(approve ? { decision: "approve" } : { decision: "reject", cause: "user", reason: "Keep the original" });
      });
      await assert.rejects(tool.execute("1", { patch }, undefined, undefined, ctx), /Keep the original/);
      assert.equal(await readFile(source, "utf8"), "old\n");
      await assert.rejects(access(destination));
      // The invalid hunk must not be inspected against file contents before
      // authorization. Rejection wins over the native matching error.
      await assert.rejects(tool.execute("2", { patch: patch.replace("-old", "-missing") },
        undefined, undefined, ctx), /Keep the original/);
      approve = true;
      const result = await tool.execute("3", { patch }, undefined, undefined, ctx);
      assert.equal(result.content[0]!.type, "text");
      assert.equal((result.content[0] as { text: string }).text,
        "Success. Updated the following files:\nM source\n");
      assert.equal(await readFile(destination, "utf8"), "new\n");
      await assert.rejects(access(source));
      assert.equal(tool.executionMode, "sequential");
      assert.equal(tool.promptSnippet, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
