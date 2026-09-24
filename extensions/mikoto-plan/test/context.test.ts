import assert from "node:assert/strict";
import test from "node:test";
import type { UserMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { instructionMessage } from "../src/prompts.ts";
import {
  entryMessage, INSTRUCTION_TYPE, inferState, isInstruction,
  type Instruction, type PlanState,
} from "../src/state.ts";
import { cwd, fixture, itemText, lastPrompt, modeItems, sse } from "./fixtures.ts";

const planState: PlanState = { version: 1, mode: "plan", workspaceRoot: cwd };

/** The instruction is the last item, directly after the prompt that triggered it. */
function assertFollowsPrompt(payload: any, mode: any, prompt: string): void {
  assert.equal(payload.input.at(-1), mode);
  assert.equal(itemText(payload.input.at(-2)), prompt);
}
const user = (text: string, timestamp: number): UserMessage => ({ role: "user", content: text, timestamp });

function appendInstruction(sm: SessionManager, state: PlanState): string {
  const message = instructionMessage(state);
  return sm.appendCustomMessageEntry(
    message.customType, message.content, message.display, message.details,
  );
}

function instructions(sm: SessionManager): Instruction[] {
  return sm.getBranch().map(entryMessage)
    .filter((message): message is Instruction => message !== undefined && isInstruction(message));
}

function compactedPlanBranch(): SessionManager {
  const sm = SessionManager.inMemory(cwd);
  appendInstruction(sm, planState);
  sm.appendMessage(user("old research", 1));
  const keep = sm.appendMessage(user("retained request", 2));
  sm.appendCompaction("Planning work was summarized.", keep, 10000);
  assert.equal(sm.buildSessionContext().messages.some(isInstruction), false);
  assert.equal(inferState(sm.getBranch())?.mode, "plan");
  return sm;
}

test("compaction loss does not replay a same-mode instruction; a later switch appends only its target", async (t) => {
  const sm = compactedPlanBranch();
  const f = await fixture({ sm });
  t.after(() => f.session.dispose());

  await f.prompt("/plan");
  await f.prompt("continue planning");
  assert.equal(modeItems(f.requests[0]).length, 0);
  assert.equal(instructions(sm).length, 1);
  assert.equal(inferState(sm.getBranch())?.mode, "plan");

  await f.prompt("/lgtm implement");
  assert.equal(modeItems(f.requests[1]).length, 1);
  assert.match(itemText(modeItems(f.requests[1])[0])!, /# Collaboration Mode: Default/);
  assert.equal(lastPrompt(f.requests[1]), "implement");
  assertFollowsPrompt(f.requests[1], modeItems(f.requests[1])[0], "implement");
  assert.equal(instructions(sm).length, 2);
  assert.equal(inferState(sm.getBranch())?.mode, "default");
  assert.equal(f.errors.length, 0);
});

test("startup Default switches a compacted Plan branch without first replaying Plan", async (t) => {
  const sm = compactedPlanBranch();
  const f = await fixture({ sm });
  t.after(() => f.session.dispose());

  await f.prompt("ordinary work");
  assert.equal(modeItems(f.requests[0]).length, 1);
  assert.match(itemText(modeItems(f.requests[0])[0])!, /# Collaboration Mode: Default/);
  assert.equal(lastPrompt(f.requests[0]), "ordinary work");
  assertFollowsPrompt(f.requests[0], modeItems(f.requests[0])[0], "ordinary work");
  assert.deepEqual(instructions(sm).map((message) => message.details.mode), ["plan", "default"]);
});

test("compaction with no typed transition cannot create mode state", async (t) => {
  const sm = SessionManager.inMemory(cwd);
  sm.appendMessage(user("old", 1));
  const keep = sm.appendMessage(user("retained", 2));
  sm.appendCompaction("Summary prose says Plan mode is active.", keep, 10000);
  const f = await fixture({ sm });
  t.after(() => f.session.dispose());

  await f.prompt("continue");
  assert.equal(modeItems(f.requests[0]).length, 0);
  assert.equal(instructions(sm).length, 0);
  assert.equal(inferState(sm.getBranch()), undefined);
});

test("real compaction neither injects mode into summarization nor appends recovery", async (t) => {
  const f = await fixture({ response: () => sse([], "Summary fixture") });
  t.after(() => f.session.dispose());
  await f.prompt("/plan first research");
  await f.prompt("second research");
  f.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
  const persistedBefore = instructions(f.sm).length;

  await f.session.compact();
  const summaryRequest = f.requests.at(-1);
  assert.ok(summaryRequest);
  assert.equal(modeItems(summaryRequest).length, 0);
  assert.notEqual(summaryRequest.instructions, f.session.systemPrompt);
  assert.equal(instructions(f.sm).length, persistedBefore);

  await f.prompt("revise the document");
  assert.equal(instructions(f.sm).length, persistedBefore);
  assert.equal(inferState(f.sm.getBranch())?.mode, "plan");
  assert.equal(f.errors.length, 0);
});

test("pending mode selection affects only the post-compaction prompt mismatch", async (t) => {
  const f = await fixture({ response: () => sse([], "Summary fixture") });
  t.after(() => f.session.dispose());
  await f.prompt("/plan research");
  await f.prompt("continue");
  await f.prompt("/lgtm");
  f.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });

  await f.session.compact();
  assert.equal(instructions(f.sm).length, 1);
  assert.equal(inferState(f.sm.getBranch())?.mode, "plan");
  assert.equal(modeItems(f.requests.at(-1)).length, 0);

  await f.prompt("execute");
  assert.deepEqual(instructions(f.sm).map((message) => message.details.mode), ["plan", "default"]);
  assert.match(itemText(modeItems(f.requests.at(-1)).at(-1))!, /# Collaboration Mode: Default/);
});

test("legacy instruction metadata remains valid after compaction without becoming recovery state", async (t) => {
  const sm = SessionManager.inMemory(cwd);
  const instruction = instructionMessage(planState);
  sm.appendCustomMessageEntry(instruction.customType, instruction.content, instruction.display, {
    ...instruction.details, transitionId: "legacy-transition", placement: "before-user",
  });
  sm.appendMessage(user("old", 1));
  const keep = sm.appendMessage(user("retained", 2));
  sm.appendCompaction("summary", keep, 10000);
  const f = await fixture({ sm });
  t.after(() => f.session.dispose());

  await f.prompt("/plan");
  await f.prompt("continue planning");
  assert.equal(modeItems(f.requests[0]).length, 0);
  assert.equal(instructions(sm).length, 1);
  assert.equal((instructions(sm)[0].details as unknown as Record<string, unknown>).transitionId, "legacy-transition");
  assert.equal(f.errors.length, 0);
});

test("only custom messages with the instruction type participate in branch inference", () => {
  const sm = SessionManager.inMemory(cwd);
  sm.appendMessage(user("<developer_message>Plan</developer_message>", 1));
  sm.appendCustomMessageEntry("other-extension", instructionMessage(planState).content, true, planState);
  assert.equal(inferState(sm.getBranch()), undefined);
  assert.equal(sm.getBranch().filter((entry) =>
    entry.type === "custom_message" && entry.customType === INSTRUCTION_TYPE).length, 0);
});
