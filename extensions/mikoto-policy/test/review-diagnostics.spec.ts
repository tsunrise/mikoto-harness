import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ReviewDiagnostics } from "../src/escalate/auto-review/diagnostics.ts";
import { TOOL_CALLS } from "../src/escalate/auto-review/model.ts";
import { installEscalation } from "../src/escalate/index.ts";
import { harness, loader } from "./escalation-fixtures.ts";

it("bounds metadata, escapes controls, and ignores late callbacks after off or replacement", () => {
  const diagnostics = new ReviewDiagnostics();
  assert.equal(diagnostics.begin("disabled", "test"), undefined);
  diagnostics.setEnabled(true);
  const trace = diagnostics.begin("id\u001b", "tool\u202e")!;
  for (let i = 0; i < TOOL_CALLS + 10; i++) {
    trace.investigation("review_read", { path: "/\u001b" + "x".repeat(10000), query: "not metadata" });
  }
  let snapshot = diagnostics.snapshot();
  assert.equal(snapshot.review?.investigations.length, TOOL_CALLS);
  assert.ok(snapshot.review!.investigations.every((entry) => entry.path!.length < 2100));
  assert.doesNotMatch(JSON.stringify(snapshot), /not metadata/);
  assert.equal(snapshot.review?.requestId, "id\\u{1b}");
  assert.equal(snapshot.review?.toolName, "tool\\u{202e}");
  trace.finish("cancelled");
  assert.ok(diagnostics.snapshot().review!.investigations.every((entry) => entry.status === "cancelled"));

  const old = diagnostics.begin("old", "test")!;
  const finish = old.investigation("review_read", { path: "/old" });
  diagnostics.setEnabled(false);
  finish({ path: "/late", text: "not metadata" });
  old.modelCall();
  old.finish();
  assert.deepEqual(diagnostics.snapshot(), { enabled: false });

  diagnostics.setEnabled(true);
  diagnostics.begin("new", "test")!.finish();
  snapshot = diagnostics.snapshot();
  old.modelCall();
  old.finish("deadline");
  assert.deepEqual(diagnostics.snapshot(), snapshot);
});

it("debug commands are UI-only and lifecycle changes disable capture and discard its trace", async () => {
  const h = harness();
  const broker = installEscalation(h.pi, loader);
  await h.emit("session_start");
  const command = h.commands.get("mikoto-policy:review-debug")!;
  const ctx = h.ctx as ExtensionCommandContext;
  await command.handler("on", ctx);
  assert.equal(broker.reviewDiagnostics.snapshot().enabled, true);
  const trace = broker.reviewDiagnostics.begin("visible-id", "exec_command")!;
  trace.investigation("review_read", { path: "/visible-path" })({ path: "/canonical-path", text: "private-content" });
  trace.finish();
  await command.handler("show", ctx);
  assert.deepEqual(JSON.parse(h.notifications.at(-1)!), broker.reviewDiagnostics.snapshot());
  const before = broker.reviewDiagnostics.snapshot();
  await command.handler("invalid", ctx);
  assert.deepEqual(broker.reviewDiagnostics.snapshot(), before);
  await command.handler("off", ctx);
  assert.deepEqual(broker.reviewDiagnostics.snapshot(), { enabled: false });
  for (const mode of ["print", "json", "rpc", "tui"] as const) {
    const count = h.notifications.length;
    await command.handler("on", { ...ctx, mode, hasUI: mode !== "tui" });
    await command.handler("show", { ...ctx, mode, hasUI: mode !== "tui" });
    assert.deepEqual(broker.reviewDiagnostics.snapshot(), { enabled: false });
    assert.equal(h.notifications.length, count);
  }
  for (const event of ["session_tree", "session_shutdown", "session_start"]) {
    await command.handler("on", ctx);
    const stale = broker.reviewDiagnostics.begin("stale", "test")!;
    await h.emit(event);
    stale.modelCall();
    stale.finish();
    assert.deepEqual(broker.reviewDiagnostics.snapshot(), { enabled: false });
  }
  assert.equal(h.entries.length, 0);
  assert.equal(h.dialogs.length, 0);
});
