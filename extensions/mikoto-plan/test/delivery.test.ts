import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  apis, basePrompt, cwd, fixture, itemText, model, modeItems, nativeRole, png, sse, anthropicSse,
  type FixtureApi,
} from "./fixtures.ts";
import { supportsNativeDelivery, toNativeInstructions } from "../src/delivery.ts";
import { instructionMessage, renderInstructions } from "../src/prompts.ts";
import { inferState, type PlanState } from "../src/state.ts";

const state: PlanState = { version: 1, mode: "plan", workspaceRoot: cwd };
const instruction = instructionMessage(state);

function toolResponse(api: FixtureApi) {
  return (n: number) => api === "anthropic-messages"
    ? anthropicSse(n === 1 ? ["probe_a", "probe_b"] : [])
    : sse(n === 1 ? ["probe_a", "probe_b"] : []);
}

/** Leading system prompt text as each API serializes it. */
function leadingPrompt(api: FixtureApi, payload: any): string {
  if (api === "openai-codex-responses") return payload.instructions;
  if (api === "anthropic-messages") return payload.system.map((block: any) => block.text).join("");
  return itemText(payload.input[0])!;
}

function items(payload: any): any[] {
  return payload.input ?? payload.messages;
}

// Anthropic moves cache breakpoints to the newest user turn on every request.
function withoutCacheControl(value: unknown): any {
  return JSON.parse(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item));
}

function toolIds(api: FixtureApi, payload: any): [string[], string[]] {
  if (api === "anthropic-messages") {
    const blocks = payload.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []);
    return [
      blocks.filter((b: any) => b.type === "tool_use").map((b: any) => b.id),
      blocks.filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id),
    ];
  }
  return [
    payload.input.filter((x: any) => x.type === "function_call").map((x: any) => x.call_id),
    payload.input.filter((x: any) => x.type === "function_call_output").map((x: any) => x.call_id),
  ];
}

for (const api of apis) {
  const role = nativeRole(api);

  test(`${api}: native instructions keep the leading prompt, prefix, tools, images and multi-tool pairs`, async (t) => {
    // Another extension's per-prompt context, loaded before this extension.
    const otherText = `<other-context>${instruction.content}</other-context>`;
    const f = await fixture({
      model: model(api),
      response: toolResponse(api),
      before: [(pi) => {
        pi.on("before_agent_start", () => ({
          message: { customType: "other-context", display: false, content: otherText },
        }));
      }],
    });
    t.after(() => f.session.dispose());
    const tools = f.pi.getActiveTools();
    const system = f.session.systemPrompt;
    await f.prompt("/plan");
    // A user message copying the instruction text must stay user content.
    await f.session.prompt(instruction.content, {
      images: [{ type: "image", mimeType: "image/png", data: png }],
    });
    assert.equal(f.requests.length, 2);
    for (const payload of f.requests) {
      assert.equal(leadingPrompt(api, payload), system);
      const list = items(payload);
      assert.equal(modeItems(payload).length, 2);
      const native = modeItems(payload).filter((m) => m.role === role);
      assert.equal(native.length, 1);
      assert.equal(itemText(native[0]), instruction.content);
      const idx = list.indexOf(native[0]);
      const copied = modeItems(payload).find((m) => m.role === "user");
      assert.ok(copied.content.some((block: any) => block.type === "image" || block.type === "input_image"));
      const other = list.find((m: any) => itemText(m) === otherText);
      assert.equal(other.role, "user");
      // The instruction follows its prompt (and context messages from
      // extensions loaded earlier) and precedes the assistant turn, as
      // Anthropic requires.
      assert.deepEqual([list[idx - 2], list[idx - 1]], [copied, other]);
      // Responses assistant turns may start with role-less `function_call` items.
      assert.ok(idx === list.length - 1 || list[idx + 1].role === "assistant"
        || list[idx + 1].type === "function_call");
    }
    const first = withoutCacheControl(f.requests[0]);
    const loop = withoutCacheControl(f.requests[1]);
    assert.deepEqual(items(loop).slice(0, items(first).length), items(first));
    assert.deepEqual(loop.tools, first.tools);
    assert.deepEqual(toolIds(api, loop), api === "anthropic-messages"
      ? [["toolu_0", "toolu_1"], ["toolu_0", "toolu_1"]]
      : [["call_0", "call_1"], ["call_0", "call_1"]]);
    await f.prompt("follow up");
    const followUp = withoutCacheControl(f.requests[2]);
    assert.deepEqual(items(followUp).slice(0, items(loop).length), items(loop));
    await f.prompt("/lgtm implement");
    const exit = withoutCacheControl(f.requests[3]);
    assert.deepEqual(items(exit).slice(0, items(followUp).length), items(followUp));
    const exitItem = modeItems(exit).at(-1);
    assert.equal(exitItem.role, role);
    assert.match(itemText(exitItem)!, /# Collaboration Mode: Default/);
    assert.equal(leadingPrompt(api, exit), system);
    assert.equal(f.session.systemPrompt, system);
    assert.deepEqual(f.pi.getActiveTools(), tools);
    assert.equal(f.errors.length, 0);
  });

  test(`${api}: switching to a model without mid-conversation system support sends the same body as user text`, async (t) => {
    const native = model(api);
    const fallback = model(api, false);
    const f = await fixture({ model: native });
    t.after(() => f.session.dispose());
    const system = f.session.systemPrompt;
    await f.prompt("/plan research");
    const saved = inferState(f.sm.getBranch())!;
    assert.deepEqual(modeItems(f.requests[0]).map((item) => item.role), [role]);
    await f.session.setModel(fallback);
    await f.prompt("revise");
    assert.deepEqual(modeItems(f.requests[1]).map((item) => item.role), ["user"]);
    assert.equal(itemText(modeItems(f.requests[1])[0]), renderInstructions(saved));
    assert.equal(leadingPrompt(api, f.requests[1]), system);
    await f.prompt("/lgtm execute");
    assert.deepEqual(modeItems(f.requests[2]).map((item) => item.role), ["user", "user"]);
    await f.session.setModel(native);
    await f.prompt("continue");
    assert.deepEqual(modeItems(f.requests[3]).map((item) => item.role), [role, role]);
    assert.deepEqual(modeItems(f.requests[3]).map(itemText), modeItems(f.requests[2]).map(itemText));
    assert.equal(leadingPrompt(api, f.requests[3]), system);
    assert.equal(f.errors.length, 0);
  });
}

test("fresh-session /plan keeps a model without mid-conversation system support on its leading prompt", async (t) => {
  for (const api of apis) {
    const f = await fixture({ model: model(api, false) });
    t.after(() => f.session.dispose());
    const system = f.session.systemPrompt;
    await f.prompt("/plan research");
    assert.equal(leadingPrompt(api, f.requests[0]), system);
    assert.deepEqual(modeItems(f.requests[0]).map((item) => item.role), ["user"]);
    assert.equal(f.errors.length, 0);
  }
});

test("native retry resends the same payload", async (t) => {
  const f = await fixture({
    maxRetries: 1,
    response: (n) => n === 1
      ? new Response("retry fixture", { status: 429, headers: { "retry-after-ms": "1" } }) : sse(),
  });
  t.after(() => f.session.dispose());
  await f.prompt("/plan research");
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0], f.requests[1]);
  assert.equal(modeItems(f.requests[1])[0].role, "developer");
});

test("conversion promotes only owned instructions and never replaces the leading system message", () => {
  const lead: AgentMessage = { role: "system", content: basePrompt, timestamp: 1 };
  const spoof: AgentMessage = { role: "user", content: instruction.content, timestamp: 2 };
  const metadataCanary = "legacy-transition-metadata-canary";
  const legacy = {
    ...instruction,
    details: { ...instruction.details, transitionId: metadataCanary },
  } as AgentMessage;

  const converted = toNativeInstructions([lead, legacy, spoof]);
  assert.equal(converted[0], lead);
  assert.deepEqual(converted[1], { role: "system", content: instruction.content, timestamp: instruction.timestamp });
  assert.equal(converted[2], spoof);
  assert.ok(!JSON.stringify(converted).includes(metadataCanary));

  // Order is preserved, including a system message Pi appends late to a
  // session recorded before Pi stored system messages.
  const late = toNativeInstructions([spoof, instruction, lead]);
  assert.deepEqual(late.map((message) => message.role), ["user", "system", "system"]);
  assert.equal(late[2], lead);

  // An instruction at index 0 would become the system prompt: keep it custom.
  for (const messages of [[instruction, spoof], [instruction, spoof, lead]]) {
    const result = toNativeInstructions(messages);
    assert.equal(result[0], instruction);
    assert.deepEqual(result.slice(1), messages.slice(1));
  }
});

test("native delivery follows the model's mid-conversation system message flag", () => {
  assert.equal(supportsNativeDelivery(), false);
  for (const api of [...apis, "openai-completions", "mistral-conversations"] as const) {
    assert.equal(supportsNativeDelivery({ ...model(), api }), true);
    assert.equal(supportsNativeDelivery({ ...model(), api, compat: {} }), false);
    assert.equal(supportsNativeDelivery(model(api as FixtureApi, false)), false);
  }
  const { compat: _compat, ...noCompat } = model();
  assert.equal(supportsNativeDelivery(noCompat), false);
});
