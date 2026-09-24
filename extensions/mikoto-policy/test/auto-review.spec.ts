import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, mock } from "node:test";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ToolCall } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AutoReviewer } from "../src/escalate/auto-review/index.ts";
import { parseAssessment } from "../src/escalate/auto-review/assessment.ts";
import { fragment, parentSnapshot, FRAGMENT_BYTES } from "../src/escalate/auto-review/context.ts";
import { InvestigationTools } from "../src/escalate/auto-review/tools.ts";
import { DEADLINE_MS } from "../src/escalate/auto-review/model.ts";
import { ReviewDiagnostics } from "../src/escalate/auto-review/diagnostics.ts";
import { loaded, request } from "./escalation-fixtures.ts";
import type { MikotoPolicyLoadResult } from "../src/config.ts";

export const model: Model<Api> = {
  id: "reviewer", provider: "fake", name: "Reviewer", api: "openai-responses", baseUrl: "https://unused.invalid",
  reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 10000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export const response = (text = '{"outcome":"allow"}', calls?: Omit<ToolCall, "type">[]): AssistantMessage => ({
  role: "assistant", api: model.api, provider: model.provider, model: model.id,
  content: calls ? calls.map((call) => ({ type: "toolCall", ...call })) : [{ type: "text", text }],
  stopReason: calls ? "toolUse" : "stop", timestamp: 1,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
function fixture(
  produce: (index: number, context: Context, options: SimpleStreamOptions) => Promise<AssistantMessage> | AssistantMessage = () => response(),
  overrides: Partial<MikotoPolicyLoadResult> = {},
  selectedModel = model,
) {
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage({ role: "user", content: "Please inspect /tmp/probe", timestamp: 1 });
  const calls: { context: Context; options: SimpleStreamOptions }[] = [];
  const finds: string[][] = [];
  const ctx = {
    cwd: "/tmp", sessionManager: manager,
    getSystemPrompt: () => "Parent task constraints",
    modelRegistry: {
      find(provider: string, name: string) { finds.push([provider, name]); return selectedModel; },
      streamSimple(selected: Model<Api>, context: Context, options: SimpleStreamOptions) {
        assert.equal(selected, selectedModel);
        calls.push({ context: structuredClone(context), options });
        return { result: () => Promise.resolve(produce(calls.length - 1, context, options)) };
      },
    },
  } as unknown as ExtensionContext;
  let current = true;
  const diagnostics = new ReviewDiagnostics();
  const reviewer = new AutoReviewer(ctx, { ...loaded, settings: {
    escalation: "auto-review", autoReview: { agent: { provider: "fake", model: "reviewer", thinkingLevel: "low" },
      policy: "Caller custom policy.\nKeep this exact." },
  }, ...overrides }, () => { if (!current) throw new Error("stale"); }, () => true,
  () => [{ path: "/tmp/AGENTS.md", content: "Loaded parent instructions" }], diagnostics);
  return { reviewer, calls, finds, ctx, manager, diagnostics, invalidate: () => { current = false; } };
}
const signal = () => new AbortController().signal;

it("parses only complete strict assessments and normalizes shorthand", () => {
  assert.deepEqual(parseAssessment('```json\n{"outcome":"allow"}\n```'), {
    outcome: "allow", risk_level: "low", user_authorization: "unknown",
    rationale: parseAssessment('{"outcome":"allow"}').rationale,
  });
  assert.equal(parseAssessment('{"outcome":"deny","rationale":"stop\\u001b[31m"}').rationale, "stop\\u{1b}[31m");
  assert.equal(parseAssessment('{"outcome":"deny"}').risk_level, "high");
  for (const value of ["", "[]", '{"outcome":"yes"}', '{"outcome":"allow","extra":1}',
    'prose {"outcome":"allow"}', '{"outcome":"allow"}{"outcome":"deny"}',
    '{"outcome":"deny","risk_level":"safe"}', JSON.stringify({ outcome: "deny", rationale: "界".repeat(2000) })]) {
    assert.throws(() => parseAssessment(value));
  }
});

it("maps requested thinking with Pi's supported-level helper without changing models", async () => {
  for (const [requested, effective, reasoning] of [
    ["off", undefined, true], ["max", "high", true], ["low", undefined, false],
  ] as const) {
    const f = fixture(undefined, { settings: { escalation: "auto-review", autoReview: {
      agent: { provider: "fake", model: "reviewer", thinkingLevel: requested }, policy: "",
    } } }, { ...model, reasoning });
    assert.deepEqual(await f.reviewer.review(request(), signal()), { decision: "approve" });
    assert.equal(f.calls[0]!.options.reasoning, effective);
  }
});

it("resolves the configured model, private tools, exact action, custom policy and independent cache identity", async () => {
  const f = fixture();
  const action = { toolName: "third_party.unregistered", input: { text: "exact\n界", nested: [1, false, null] } };
  assert.deepEqual(await f.reviewer.review({ ...request(), action }, signal()), { decision: "approve" });
  assert.deepEqual(f.finds, [["fake", "reviewer"]]);
  const call = f.calls[0]!;
  assert.equal(call.options.reasoning, "low");
  assert.equal(call.options.cacheRetention, "short");
  assert.equal(call.options.maxTokens, 8192);
  assert.ok(call.options.signal instanceof AbortSignal);
  assert.notEqual(call.options.sessionId, f.manager.getSessionId());
  assert.deepEqual(call.context.tools?.map((tool) => tool.name),
    ["review_stat", "review_read", "review_list", "review_search"]);
  assert.ok(call.context.systemPrompt?.includes(JSON.stringify("Caller custom policy.\nKeep this exact.")));
  const evidence = JSON.parse(call.context.messages[0]!.content as string);
  assert.deepEqual(evidence.action, action);
  assert.deepEqual(evidence.parentConstraints.contextFiles,
    [{ path: "/tmp/AGENTS.md", content: "Loaded parent instructions" }]);
  assert.equal(evidence.conversation[0].sourceId, f.manager.getLeafId());
  assert.equal(evidence.conversation[0].evidence.provenance, "human_request");
  f.manager.appendMessage({ role: "user", content: "And now inspect another file", timestamp: 2 });
  await f.reviewer.review(request("second"), signal());
  assert.equal(f.calls[1]!.options.sessionId, call.options.sessionId);
  assert.equal(JSON.parse(f.calls[1]!.context.messages.at(-1)!.content as string).evidenceMode, "delta");
});

it("investigates locally with matching result IDs and commits both allow and deny", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-roundtrip-"));
  try {
    const path = join(directory, "probe");
    await writeFile(path, "local evidence");
    const f = fixture((i) => i === 0 ? response("", [{ name: "review_read", id: "lookup", arguments: { path } }])
      : response('{"outcome":"deny","rationale":"Keep it private\\u001b"}'));
    const result = await f.reviewer.review(request(), signal());
    assert.deepEqual(result, { decision: "reject", cause: "user", reason: "Keep it private\\u{1b}" });
    const toolResult = f.calls[1]!.context.messages.at(-1)!;
    assert.equal(toolResult.role, "toolResult");
    assert.equal(toolResult.role === "toolResult" && toolResult.toolCallId, "lookup");
    assert.ok(JSON.stringify(toolResult).includes("local evidence"));
    assert.equal(await readFile(path, "utf8"), "local evidence");
    await f.reviewer.review(request("next"), signal());
    assert.equal(f.calls[2]!.options.sessionId, f.calls[0]!.options.sessionId);
    assert.equal(f.calls.length, 3); // No retries for valid denials.
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("opt-in diagnostics report investigation outcomes without evidence, queries, or assessments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-trace-"));
  try {
    const path = join(directory, "probe");
    await writeFile(path, "private-file-content\n".repeat(4000));
    const f = fixture((i) => i % 2 === 0 ? response("", [
      { name: "review_read", id: "read", arguments: { path } },
      { name: "review_search", id: "search", arguments: { path, query: "private-search-query" } },
      { name: "review_stat", id: "missing", arguments: { path: join(directory, "missing") } },
      { name: "review_read", id: "denied", arguments: { path: join(directory, "secret") } },
    ]) : response('{"outcome":"deny","rationale":"private-assessment"}'), {
      document: { ...loaded.document, filesystem: { ...loaded.document.filesystem,
        denyRead: [join(directory, "secret")] } },
    });
    await f.reviewer.review(request(), signal());
    assert.deepEqual(f.diagnostics.snapshot(), { enabled: false });
    f.diagnostics.setEnabled(true);
    const before = structuredClone(f.manager.getEntries());
    await f.reviewer.review(request("traced"), signal());
    const snapshot = f.diagnostics.snapshot();
    assert.equal(snapshot.review?.requestId, "traced");
    assert.equal(snapshot.review?.modelCalls, 2);
    assert.equal(snapshot.review?.status, "completed");
    assert.deepEqual(snapshot.review?.investigations.map((entry) => [entry.tool, entry.status]),
      [["review_read", "ok"], ["review_search", "ok"], ["review_stat", "missing"], ["review_read", "denied"]]);
    assert.equal(snapshot.review?.investigations[0]?.path, path);
    assert.equal(snapshot.review?.investigations[0]?.truncated, true);
    assert.doesNotMatch(JSON.stringify(snapshot), /private-file-content|private-search-query|private-assessment|outcome|rationale/);
    assert.deepEqual(f.manager.getEntries(), before);
    snapshot.review!.investigations.length = 0;
    assert.equal(f.diagnostics.snapshot().review?.investigations.length, 4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("records zero-investigation reviews and sanitized failures, never provider error text", async () => {
  const f = fixture((i) => {
    if (i === 0) return response();
    throw new Error("private-provider-error");
  });
  f.diagnostics.setEnabled(true);
  await f.reviewer.review(request(), signal());
  assert.deepEqual(f.diagnostics.snapshot().review, {
    requestId: "1", toolName: "write-1", modelCalls: 1, investigations: [], status: "completed",
  });
  await f.reviewer.review(request("failed"), signal());
  assert.equal(f.diagnostics.snapshot().review?.failure, "provider_or_review_failure");
  assert.equal(f.diagnostics.snapshot().review?.status, "failed");
  assert.doesNotMatch(JSON.stringify(f.diagnostics.snapshot()), /private-provider-error/);
});

it("leaves investigation room when optional parent history would fill the input budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-headroom-"));
  try {
    const path = join(directory, "evidence");
    await writeFile(path, "bounded local evidence\n".repeat(2000));
    const f = fixture((i) => i % 2 === 0
      ? response("", [{ name: "review_read", id: `lookup-${i}`, arguments: { path } }])
      : response());
    for (let i = 0; i < 200; i++) f.manager.appendMessage(response(`${i}: ${"history ".repeat(250)}`));
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await f.reviewer.review(request(`review-${i}`), signal()), { decision: "approve" });
    }
    assert.equal(f.calls.length, 6);
    for (const i of [1, 3, 5]) {
      const toolResult = f.calls[i]!.context.messages.at(-1)!;
      assert.equal(toolResult.role, "toolResult");
      assert.ok(JSON.stringify(toolResult).includes("bounded local evidence"));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("lets required action and human evidence use reserved space without truncating them", async () => {
  const f = fixture();
  const human = "h".repeat(140_000);
  const action = { toolName: "write", input: { path: "/tmp/probe", content: "c".repeat(200_000) } };
  f.manager.appendMessage({ role: "user", content: human, timestamp: 2 });
  assert.deepEqual(await f.reviewer.review({ ...request(), action }, signal()), { decision: "approve" });
  const evidence = JSON.parse(f.calls[0]!.context.messages[0]!.content as string);
  assert.deepEqual(evidence.action, action);
  assert.ok(evidence.conversation.some((entry: { evidence: { content: unknown } }) =>
    entry.evidence.content === human));
});

it("retries only invalid finals from the committed base; failures never become checkpoints", async () => {
  const f = fixture((i) => response(i === 0 ? "invalid final" : '{"outcome":"allow"}'));
  await f.reviewer.review(request(), signal());
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0]!.context, f.calls[1]!.context);
  for (const stopReason of ["length", "aborted", "error", "pending", "deferred"] as const) {
    const failed = fixture(() => ({ ...response(), stopReason }));
    assert.deepEqual(await failed.reviewer.review(request(), signal()), { decision: "reject", cause: "error" });
    assert.equal(failed.calls.length, 1);
  }
  const invalid = fixture(() => response('{"outcome":"unknown"}'));
  assert.deepEqual(await invalid.reviewer.review(request(), signal()), { decision: "reject", cause: "error" });
  assert.equal(invalid.calls.length, 3);
  const provider = fixture(() => { throw new Error("secret-provider-auth-token"); });
  const log = mock.method(console, "error", () => {});
  await provider.reviewer.review(request(), signal());
  assert.equal(provider.calls.length, 1);
  assert.ok(log.mock.calls.every((call) => !JSON.stringify(call.arguments).includes("secret-provider-auth-token")));
  log.mock.restore();
});

it("missing models, bad policy diagnostics and exhausted rounds/tools fail closed", async () => {
  const missing = fixture();
  mock.method(missing.ctx.modelRegistry, "find", () => undefined);
  assert.deepEqual(await missing.reviewer.review(request(), signal()), { decision: "reject", cause: "error" });
  assert.equal(missing.calls.length, 0);
  for (const kind of ["invalid_layer", "unreadable_layer", "canonical_rule"] as const) {
    const f = fixture(undefined, { diagnostics: [kind === "canonical_rule"
      ? { kind, path: "/secret-config", rule: "denyRead" } : { kind, path: "/secret-config" }] });
    assert.deepEqual(await f.reviewer.review(request(), signal()), { decision: "reject", cause: "error" });
    assert.equal(f.finds.length, 0);
  }
  const rounds = fixture(() => response("", [{ name: "review_stat", id: "stat", arguments: { path: "/does-not-exist" } }]));
  assert.deepEqual(await rounds.reviewer.review(request(), signal()), { decision: "reject", cause: "error" });
  assert.equal(rounds.calls.length, 8);
  const tools = fixture(() => response("", Array.from({ length: 33 }, (_, i) =>
    ({ name: "review_stat", id: String(i), arguments: { path: "/does-not-exist" } }))));
  assert.deepEqual(await tools.reviewer.review(request(), signal()), { decision: "reject", cause: "error" });
  assert.equal(tools.calls.length, 1);
  for (const call of [{ name: "exec", arguments: {} }, { name: "review_stat", arguments: { path: "/", extra: true } }]) {
    const bad = fixture(() => response("", [{ ...call, id: "bad" }]));
    assert.deepEqual(await bad.reviewer.review(request(), signal()), { decision: "reject", cause: "error" });
    assert.equal(bad.calls.length, 1);
  }
});

it("deadlines and producer abort detach ignored cancellation without contaminating subsequent reviews", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let complete!: (result: AssistantMessage) => void;
  const f = fixture((i) => i === 0 ? new Promise((resolve) => { complete = resolve; }) : response());
  f.diagnostics.setEnabled(true);
  const first = f.reviewer.review(request(), signal());
  await Promise.resolve();
  t.mock.timers.tick(DEADLINE_MS);
  assert.deepEqual(await first, { decision: "reject", cause: "error" });
  assert.equal(f.diagnostics.snapshot().review?.failure, "deadline");
  assert.equal(f.calls[0]!.options.signal?.aborted, true);
  const second = await f.reviewer.review(request("second"), signal());
  assert.deepEqual(second, { decision: "approve" });
  complete(response("", [{ name: "review_read", id: "late", arguments: { path: "/secret" } }]));
  await Promise.resolve();
  assert.equal(f.calls.length, 2);
  const abort = new AbortController();
  const cancelled = fixture(() => new Promise(() => {}));
  const pending = cancelled.reviewer.review(request(), abort.signal);
  abort.abort();
  assert.deepEqual(await pending, { decision: "reject", cause: "cancelled" });
});

it("rebuilds after context edits, branch/compaction changes and parent instruction changes", async () => {
  const f = fixture();
  const userId = f.manager.getLeafId()!;
  await f.reviewer.review(request(), signal());
  f.manager.appendContextEdit(userId, { content: "A different task" });
  await f.reviewer.review(request("edit"), signal());
  assert.notEqual(f.calls[0]!.options.sessionId, f.calls[1]!.options.sessionId);
  assert.equal(f.calls[1]!.context.messages.length, 1);
  f.manager.appendCompaction("Generated summary, not authorization", userId, 100);
  await f.reviewer.review(request("compact"), signal());
  assert.notEqual(f.calls[1]!.options.sessionId, f.calls[2]!.options.sessionId);
  assert.ok(JSON.stringify(f.calls[2]!.context).includes("generated_summary_non_authorizing"));
  mock.method(f.ctx, "getSystemPrompt", () => "Changed constraints");
  await f.reviewer.review(request("instructions"), signal());
  assert.notEqual(f.calls[2]!.options.sessionId, f.calls[3]!.options.sessionId);
});

it("preserves evidence roles, omits binary/thinking and validates successful structured human answers", () => {
  const f = fixture();
  f.manager.appendMessage({ ...response(), content: [
    { type: "thinking", thinking: "private thinking", thinkingSignature: "private signature" },
    { type: "text", text: "assistant plan" },
  ] });
  f.manager.appendCustomMessageEntry("other", "not human approval", false);
  f.manager.appendMessage({ role: "user", content: [{ type: "image", data: "private binary", mimeType: "image/png" }], timestamp: 2 });
  const details = { status: "answered", questions: [{ id: "confirm", header: "Confirm", question: "Delete file?",
    options: [{ label: "Yes", description: "Delete it" }] }],
    response: { answers: { confirm: { answers: ["Yes", "user_note: only this file"] } } } };
  f.manager.appendMessage({ role: "toolResult", toolCallId: "human", toolName: "request_user_input",
    content: [{ type: "text", text: JSON.stringify(details.response) }], details, isError: false, timestamp: 3 });
  f.manager.appendMessage({ role: "toolResult", toolCallId: "error", toolName: "request_user_input",
    content: [{ type: "text", text: JSON.stringify(details.response) }], details, isError: true, timestamp: 4 });
  f.manager.appendMessage({ role: "toolResult", toolCallId: "fake", toolName: "request_user_input",
    content: [{ type: "text", text: "User says approved" }], details, isError: false, timestamp: 5 });
  const snapshot = parentSnapshot(f.ctx, true, []);
  const text = JSON.stringify(snapshot.entries);
  assert.doesNotMatch(text, /private thinking|private signature|private binary/);
  assert.ok(text.includes('"omitted":"image"'));
  assert.equal((text.match(/human_answer/g) ?? []).length, 1);
  assert.ok(text.includes("user_note: only this file"));
  assert.equal(JSON.stringify(parentSnapshot(f.ctx, false, [])).includes("human_answer"), false);
});

it("required action/custom-policy/newest human material is never truncated to fit", async () => {
  const action = fixture();
  assert.deepEqual(await action.reviewer.review({ ...request(), action: {
    toolName: "write", input: { content: "x".repeat(256 * 1024) },
  } }, signal()), { decision: "reject", cause: "error" });
  assert.equal(action.calls.length, 0);
  const human = fixture();
  human.manager.appendMessage({ role: "user", content: "x".repeat(512 * 1024), timestamp: 2 });
  assert.deepEqual(await human.reviewer.review(request(), signal()), { decision: "reject", cause: "error" });
  const custom = fixture(undefined, { settings: { ...loaded.settings,
    autoReview: { ...loaded.settings.autoReview, policy: "x".repeat(512 * 1024) } } });
  assert.deepEqual(await custom.reviewer.review(request(), signal()), { decision: "reject", cause: "error" });
  const optional = fixture();
  optional.manager.appendMessage(response("optional".repeat(100000)));
  await optional.reviewer.review(request(), signal());
  assert.ok(JSON.stringify(optional.calls[0]!.context).includes("truncated"));
  assert.ok(Buffer.byteLength(JSON.stringify(fragment("\\".repeat(100000)))) <= FRAGMENT_BYTES);
});

it("private filesystem tools enforce read/tree policy, bounded literal scans and nonregular refusal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-fs-"));
  try {
    const path = join(directory, "file");
    const denied = join(directory, "private");
    await mkdir(denied);
    await writeFile(path, ("literal.*\nother\n").repeat(10000));
    await symlink(path, join(directory, "link"));
    const tools = new InvestigationTools(directory, { ...loaded.document,
      filesystem: { ...loaded.document.filesystem, denyRead: [denied] } }, () => {});
    assert.deepEqual(await tools.dispatch("review_read", { path: denied }, signal()), { error: "permission_denied" });
    assert.deepEqual(await tools.dispatch("review_list", { path: directory }, signal()), { error: "permission_denied" });
    assert.deepEqual(await tools.dispatch("review_stat", { path: "missing" }, signal()),
      { path: join(directory, "missing"), missing: true });
    assert.deepEqual(await tools.dispatch("review_read", { path: directory }, signal()), { error: "not_regular_file" });
    const read = await tools.dispatch("review_read", { path: "link", limit: 20 }, signal()) as { text: string; bytesRead: number };
    assert.equal(read.bytesRead, 20);
    assert.ok(read.text.startsWith("literal.*"));
    const matches = await tools.dispatch("review_search", { path, query: ".*", limit: 2 }, signal()) as { matches: unknown[]; incomplete: boolean; bytesRead: number };
    assert.equal(matches.matches.length, 2);
    assert.equal(matches.incomplete, true);
    assert.equal(matches.bytesRead, 65536);
    await assert.rejects(tools.dispatch("review_read", { path, extra: true }, signal()));
    await assert.rejects(tools.dispatch("review_read", { path }, AbortSignal.abort()));
    const all = new InvestigationTools(directory, loaded.document, () => {});
    const listing = await all.dispatch("review_list", { path: directory }, signal()) as { entries: { name: string; type: string }[] };
    assert.ok(listing.entries.some((entry) => entry.name === "link" && entry.type === "symlink"));
    assert.ok(Buffer.byteLength(JSON.stringify(await all.dispatch("review_read", { path }, signal()))) <= FRAGMENT_BYTES);
    await writeFile(join(directory, "unicode"), "界界");
    assert.deepEqual(await all.dispatch("review_read", { path: "unicode", limit: 5 }, signal()), {
      path: join(directory, "unicode"), offset: 0, bytesRead: 5, nextOffset: 3, incomplete: true, text: "界",
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
