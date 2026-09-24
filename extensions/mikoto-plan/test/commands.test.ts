import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixture, cwd, itemText, lastPrompt, modeItems } from "./fixtures.ts";
import { instructionMessage } from "../src/prompts.ts";
import {
  entryMessage, INSTRUCTION_TYPE, inferState, isInstruction,
  type Instruction, type PlanState,
} from "../src/state.ts";

const instructions = (sm: SessionManager) => sm.getBranch()
  .map(entryMessage)
  .filter((message): message is Instruction => message !== undefined && isInstruction(message));

function appendInstruction(sm: SessionManager, state: PlanState): void {
  const message = instructionMessage(state);
  sm.appendCustomMessageEntry(
    message.customType, message.content, message.display, message.details,
  );
}

test("all command forms, ordinary Plan input, setters, whitespace, and literal slash arguments", async (t) => {
  const f = await fixture();
  t.after(() => f.session.dispose());
  const tools = f.pi.getActiveTools();
  await f.prompt("/lgtm");
  assert.equal(f.sm.getBranch().filter((e) => e.type === "custom").length, 0);
  await f.prompt("/plan");
  assert.equal(f.requests.length, 0);
  assert.equal(f.statuses.size, 0);
  assert.equal(f.sm.getBranch().filter((e) => e.type === "custom_message").length, 0);
  await f.prompt("/plan   ");
  await f.prompt("/plan");
  assert.equal(instructions(f.sm).length, 0);
  await f.prompt("Research the feature");
  assert.equal(f.requests.length, 1);
  await f.prompt("looks good, implement it");
  assert.equal(inferState(f.sm.getBranch())?.mode, "plan");
  assert.equal(modeItems(f.requests[1]).length, 1);
  const noticesBeforePlanPrompt = f.notifications.length;
  await f.prompt("/plan /lgtm do not dispatch this");
  assert.equal(f.requests.length, 3);
  assert.equal(f.notifications.length, noticesBeforePlanPrompt);
  assert.equal(inferState(f.sm.getBranch())?.mode, "plan");
  assert.equal(lastPrompt(f.requests[2]), "/lgtm do not dispatch this");
  const beforeExit = structuredClone(f.sm.getBranch());
  await f.prompt("/lgtm");
  assert.equal(f.requests.length, 3);
  assert.equal(f.statuses.size, 0);
  assert.deepEqual(f.sm.getBranch(), beforeExit);
  await f.prompt("/lgtm   ");
  const noticesBeforeDefaultPrompt = f.notifications.length;
  await f.prompt("/lgtm implement now");
  assert.equal(f.requests.length, 4);
  assert.equal(f.notifications.length, noticesBeforeDefaultPrompt);
  assert.equal(modeItems(f.requests[3]).length, 2);
  assert.match(itemText(modeItems(f.requests[3])[1])!, /Default/);
  assert.equal(lastPrompt(f.requests[3]), "implement now");
  assert.equal(instructions(f.sm).length, 2);
  assert.equal(inferState(f.sm.getBranch())?.mode, "default");
  assert.deepEqual(f.pi.getActiveTools(), tools);
  assert.equal(f.errors.length, 0);
});

test("pure command notifications reflect the active branch's sent mode", async (t) => {
  const f = await fixture();
  t.after(() => f.session.dispose());
  const observed: string[] = [];
  async function command(text: string): Promise<void> {
    const before = f.notifications.length;
    await f.prompt(text);
    const emitted = f.notifications.slice(before);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].level, "info");
    observed.push(emitted[0].text);
  }

  await command("/lgtm");
  await command("/plan");
  await command("/plan   ");
  assert.equal(observed[1], observed[2]);
  assert.equal(f.requests.length, 0);

  await f.prompt("research");
  await command("/plan");
  await command("/lgtm");
  await command("/lgtm   ");
  assert.equal(observed[4], observed[5]);
  assert.equal(f.requests.length, 1);

  await f.prompt("execute");
  await command("/lgtm");
  assert.equal(observed[0], observed[6]);
  assert.equal(new Set([observed[0], observed[1], observed[3], observed[4]]).size, 4);
  assert.equal(instructions(f.sm).length, 2);
  assert.ok(f.notifications.every((notification) => notification.level === "info"));
});

test("opposite bare setters cancel each other without instructions or history entries", async (t) => {
  const f = await fixture();
  t.after(() => f.session.dispose());
  await f.prompt("/plan");
  await f.prompt("/lgtm");
  await f.prompt("ordinary work");
  assert.equal(modeItems(f.requests[0]).length, 0);
  assert.equal(instructions(f.sm).length, 0);
  await f.prompt("/plan new task");
  assert.equal(f.requests.length, 2);
  assert.equal(modeItems(f.requests[1]).length, 1);
  assert.equal(lastPrompt(f.requests[1]), "new task");
  const branch = structuredClone(f.sm.getBranch());
  await f.prompt("/lgtm");
  await f.prompt("/plan");
  assert.deepEqual(f.sm.getBranch(), branch);
  await f.prompt("still planning");
  assert.equal(modeItems(f.requests[2]).length, 1);
  assert.equal(instructions(f.sm).length, 1);
});

test("busy commands reject instead of queuing mode changes or prompts", async (t) => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture({ after: [(pi) => {
    pi.on("before_provider_request", async () => {
      started();
      await gate;
    });
  }] });
  t.after(() => f.session.dispose());
  await f.prompt("/plan");
  f.notifications.length = 0;
  const running = f.session.prompt("research");
  await ready;
  const branch = structuredClone(f.sm.getBranch());
  await f.session.prompt("/lgtm execute");
  await f.session.prompt("/plan more");
  assert.deepEqual(f.sm.getBranch(), branch);
  assert.equal(f.notifications.length, 2);
  assert.ok(f.notifications.every((n) => n.level === "warning"));
  release();
  await running;
  assert.equal(f.requests.length, 1);
  assert.equal(inferState(f.sm.getBranch())?.mode, "plan");
});

test("missing question tool warns once and never changes the active set", async (t) => {
  const f = await fixture({ question: false });
  t.after(() => f.session.dispose());
  const tools = f.pi.getActiveTools();
  await f.prompt("/plan");
  await f.prompt("/lgtm");
  await f.prompt("/plan");
  const warnings = f.notifications.filter((notification) => notification.level === "warning");
  const information = f.notifications.filter((notification) => notification.level === "info");
  assert.equal(warnings.length, 1);
  assert.equal(information.length, 3);
  assert.deepEqual(f.pi.getActiveTools(), tools);
});

test("startup defaults to non-plan; only sent instructions survive reload/resume/fork/clone", async (t) => {
  const f = await fixture();
  t.after(() => f.session.dispose());
  await f.prompt("/plan");
  const pendingBranch = structuredClone(f.sm.getBranch());
  await f.prompt("research");
  const deliveredBranch = structuredClone(f.sm.getBranch());
  await f.prompt("/lgtm execute");
  const defaultBranch = structuredClone(f.sm.getBranch());
  for (const branch of [pendingBranch, deliveredBranch, defaultBranch]) {
    // Same persisted active path used by reload/resume/fork/clone. In-memory
    // reconstruction avoids writing fixture session files into the user's home.
    const sm = SessionManager.inMemory(cwd, {}, branch);
    const restored = await fixture({ sm });
    try {
      const previous = branch === deliveredBranch ? "plan" : "default";
      assert.equal(inferState(sm.getBranch())?.mode ?? "default", previous);
      await restored.prompt("continue");
      assert.equal(modeItems(restored.requests[0]).length, branch === pendingBranch ? 0 : 2);
      assert.equal(inferState(sm.getBranch())?.mode ?? "default", "default");
      assert.equal(instructions(sm).length, branch === pendingBranch ? 0 : 2);
      assert.equal(restored.statuses.size, 0);
      assert.equal(restored.errors.length, 0);
    } finally {
      restored.session.dispose();
    }
  }
  // Explicitly selecting Plan before the first prompt on a resumed Plan
  // branch cancels the startup Default intent without adding another entry.
  const sm = SessionManager.inMemory(cwd, {}, deliveredBranch);
  const resumed = await fixture({ sm });
  t.after(() => resumed.session.dispose());
  await resumed.prompt("/plan");
  assert.deepEqual(sm.getBranch(), deliveredBranch);
  await resumed.prompt("continue planning");
  assert.equal(modeItems(resumed.requests[0]).length, 1);
  assert.equal(instructions(sm).length, 1);
});

test("tree navigation preserves memory selection and infers only the current branch's sent state", async (t) => {
  const f = await fixture();
  t.after(() => f.session.dispose());
  const root = f.sm.appendCustomEntry("unrelated", {});
  await f.prompt("/plan research");
  const planLeaf = f.sm.getLeafId()!;
  await f.prompt("/lgtm execute");
  const defaultLeaf = f.sm.getLeafId()!;

  await f.session.navigateTree(planLeaf);
  assert.equal(inferState(f.sm.getBranch())?.mode, "plan");
  await f.prompt("normal work on this branch");
  assert.equal(inferState(f.sm.getBranch())?.mode, "default");
  assert.equal(modeItems(f.requests.at(-1)).length, 2);

  await f.prompt("/plan");
  await f.session.navigateTree(defaultLeaf);
  await f.prompt("research on the other branch");
  assert.equal(inferState(f.sm.getBranch())?.mode, "plan");
  assert.equal(modeItems(f.requests.at(-1)).length, 3);

  await f.session.navigateTree(root);
  assert.equal(inferState(f.sm.getBranch()), undefined);
  await f.prompt("fresh research");
  assert.equal(modeItems(f.requests.at(-1)).length, 1);
  assert.equal(instructions(f.sm).length, 1);
  assert.equal(f.statuses.size, 0);
});

test("history renders each instruction as one blue event without exposing its metadata to the LLM", async (t) => {
  const f = await fixture();
  t.after(() => f.session.dispose());
  const events: string[] = [];
  f.session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "custom"
      && event.message.customType === INSTRUCTION_TYPE) events.push("instruction");
  });
  await f.prompt("/plan");
  assert.deepEqual(events, []);
  await f.prompt("research");
  await f.prompt("/lgtm");
  assert.deepEqual(events, ["instruction"]);
  await f.prompt("execute");
  assert.deepEqual(events, ["instruction", "instruction"]);
  const renderer = f.session.extensionRunner.getMessageRenderer(INSTRUCTION_TYPE)!;
  const labels: string[] = [];
  const messages = instructions(f.sm);
  assert.ok(messages.every((message) => message.display));
  assert.equal(f.sm.getBranch().filter((entry) => entry.type === "custom").length, 0);
  for (const message of messages) {
    const rendered = renderer(
      message, { expanded: false, outputPad: 1 },
      f.session.extensionRunner.createContext().ui.theme,
    )!;
    assert.ok(rendered);
    const output = rendered.render(80).join("\n");
    assert.match(output, /\x1b\[34m[^\x1b]+\x1b\[39m/);
    const label = stripAnsi(output).trim();
    assert.ok(label.length > 0);
    labels.push(label);
  }
  const serializedRequests = JSON.stringify(f.requests);
  assert.ok(!serializedRequests.includes(INSTRUCTION_TYPE));
  assert.ok(messages.every((message) =>
    Object.keys(message.details).sort().join(",") === "mode,version,workspaceRoot"));
  assert.notEqual(labels[0], labels[1]);
  assert.equal(renderer({ ...messages[0], details: { version: 99 } } as any,
    { expanded: false, outputPad: 1 }, f.session.extensionRunner.createContext().ui.theme), undefined);
  assert.equal(messages.length, 2);
  assert.equal(f.statuses.size, 0);
});

test("actual prompts persist each transition immediately after its triggering user message", async (t) => {
  const f = await fixture();
  t.after(() => f.session.dispose());
  await f.prompt("/plan research");
  await f.prompt("/lgtm implement");
  const branch = f.sm.getBranch();
  const indexes = branch.flatMap((entry, index) =>
    entry.type === "custom_message" && entry.customType === INSTRUCTION_TYPE ? [index] : []);
  assert.equal(indexes.length, 2);
  // Pi's initial system message is recorded first, so it never sits between.
  assert.ok(indexes[0] > branch.findIndex((entry) => entry.type === "message" && entry.message.role === "system"));
  for (const [index, text] of [[indexes[0], "research"], [indexes[1], "implement"]] as const) {
    const previous = branch[index - 1];
    assert.ok(previous?.type === "message" && previous.message.role === "user");
    assert.equal((previous.message.content as { type: string; text: string }[])[0].text, text);
  }
  for (const [context, text] of [[f.providerContexts[0], "research"], [f.providerContexts[1], "implement"]] as const) {
    assert.equal(context.messages[0].role, "system");
    const messages = context.messages.slice(-2);
    assert.deepEqual(messages.map((message: any) => message.role), ["user", "system"]);
    assert.equal(messages[0].content[0].text, text);
    assert.match(messages[1].content, /^<collaboration_mode>/);
  }
  for (const [request, text] of [[f.requests[0], "research"], [f.requests[1], "implement"]] as const) {
    const mode = modeItems(request).at(-1);
    assert.equal(mode.role, "developer");
    assert.equal(request.input.at(-1), mode);
    assert.equal(request.input.at(-2).content[0].text, text);
  }
  assert.equal(instructions(f.sm).length, 2);
  assert.equal(inferState(f.sm.getBranch())?.mode, "default");
  assert.equal(f.errors.length, 0);
});

test("only valid instruction metadata infers mode; legacy extras, summary prose, and user tags do not", () => {
  const sm = SessionManager.inMemory(cwd);
  sm.appendCustomMessageEntry("other-context", '<collaboration_mode>\nEnter Plan Mode</collaboration_mode>', false);
  sm.branchWithSummary(sm.getLeafId()!, "Plan mode is active");
  sm.appendCustomMessageEntry(INSTRUCTION_TYPE, "invalid", true, {
    version: 1, mode: "plan", transitionId: "invalid", placement: "before-user",
  });
  assert.equal(inferState(sm.getBranch()), undefined);
  const state: PlanState = { version: 1, mode: "plan", workspaceRoot: cwd };
  const legacy = instructionMessage(state);
  sm.appendCustomMessageEntry(legacy.customType, legacy.content, legacy.display, {
    ...legacy.details, transitionId: "legacy", placement: "before-user",
  });
  assert.equal(inferState(sm.getBranch())?.mode, "plan");
  appendInstruction(sm, { ...state, mode: "default" });
  assert.equal(inferState(sm.getBranch())?.mode, "default");
});
