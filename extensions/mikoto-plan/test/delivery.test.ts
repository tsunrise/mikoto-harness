import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fixture, model, modeItems, sse, basePrompt, cwd } from "./fixtures.ts";
import { ResponsesDelivery, supportsNativeDelivery } from "../src/delivery.ts";
import { instructionMessage, renderInstructions } from "../src/prompts.ts";
import { isInstruction, inferState, type PlanState } from "../src/state.ts";

const state: PlanState = { version: 1, mode: "plan", workspaceRoot: cwd };
const instruction = instructionMessage(state);

for (const api of ["openai-codex-responses", "openai-responses"] as const) {
  test(`${api}: real conversion/serialization keeps prefix, tools, images and multi-tool pairs`, async (t) => {
    const zedText = `<zed-context>${instruction.content}</zed-context>`;
    const f = await fixture({
      model: model(api),
      response: (n) => sse(n === 1 ? ["probe_a", "probe_b"] : []),
      before: [(pi) => pi.on("before_agent_start", () => ({
        message: { customType: "zed-context", display: false, content: zedText },
      }))],
    });
    t.after(() => f.session.dispose());
    const tools = f.pi.getActiveTools();
    const system = f.session.agent.state.systemPrompt;
    await f.prompt("/plan");
    await f.session.prompt(instruction.content, {
      images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
    });
    assert.equal(f.requests.length, 2);
    for (const payload of f.requests) {
      assert.equal(modeItems(payload).length, 2); // our instruction + copied USER text
      const native = modeItems(payload).filter((m) => m.role === "developer");
      assert.equal(native.length, 1);
      const idx = payload.input.indexOf(native[0]);
      assert.equal(payload.input[idx + 1].role, "user");
      assert.equal(payload.input[idx + 1].content[0].text, instruction.content);
      assert.equal(payload.input[idx + 1].content[1].type, "input_image");
      assert.equal(payload.input[idx + 2].role, "user");
      assert.equal(payload.input[idx + 2].content[0].text, zedText);
      assert.ok(!JSON.stringify(payload).includes("mikoto-plan-carrier:"));
      if (api === "openai-codex-responses") assert.equal(payload.instructions, system);
      else assert.equal(payload.input[0].content, system);
    }
    const first = f.requests[0];
    const loop = f.requests[1];
    assert.deepEqual(loop.input.slice(0, first.input.length), first.input);
    assert.deepEqual(loop.tools, first.tools);
    assert.deepEqual(loop.input.filter((x: any) => x.type === "function_call").map((x: any) => x.call_id), ["call_0", "call_1"]);
    assert.deepEqual(loop.input.filter((x: any) => x.type === "function_call_output").map((x: any) => x.call_id), ["call_0", "call_1"]);
    await f.prompt("follow up");
    assert.deepEqual(f.requests[2].input.slice(0, loop.input.length), loop.input);
    const previousInput = f.requests[2].input;
    await f.prompt("/lgtm implement");
    assert.deepEqual(f.requests[3].input.slice(0, previousInput.length), previousInput);
    assert.equal(f.requests[3].input.at(-3).role, "developer");
    assert.match(f.requests[3].input.at(-3).content[0].text, /# Collaboration Mode: Default/);
    assert.equal(f.session.agent.state.systemPrompt, system);
    assert.deepEqual(f.pi.getActiveTools(), tools);
    assert.ok(!JSON.stringify(f.sm.getEntries()).includes("mikoto-plan-carrier:"));
    assert.equal(f.errors.length, 0);
  });

  test(`${api}: fallback/native model switches preserve the same canonical body and branch state`, async (t) => {
    const native = model(api);
    const fallback = { ...native, compat: { supportsDeveloperRole: false } };
    const f = await fixture({ model: native });
    t.after(() => f.session.dispose());
    const system = f.session.agent.state.systemPrompt;
    await f.prompt("/plan research");
    const saved = inferState(f.sm.getBranch())!;
    const text = modeItems(f.requests[0])[0].content[0].text;
    await f.session.setModel(fallback);
    await f.prompt("revise");
    assert.equal(modeItems(f.requests[1])[0].role, "user");
    assert.equal(modeItems(f.requests[1])[0].content[0].text, text);
    assert.ok(!JSON.stringify(f.providerContexts.at(-1)).includes("mikoto-plan-carrier:"));
    await f.prompt("/lgtm execute");
    assert.deepEqual(modeItems(f.requests[2]).map((item) => item.role), ["user", "user"]);
    await f.session.setModel(native);
    await f.prompt("continue");
    assert.deepEqual(modeItems(f.requests[3]).map((item) => item.role), ["developer", "developer"]);
    assert.deepEqual(modeItems(f.requests[3]).map((item) => item.content),
      modeItems(f.requests[2]).map((item) => item.content));
    assert.equal(modeItems(f.requests[3])[0].content[0].text, renderInstructions(saved));
    assert.equal(f.session.agent.state.systemPrompt, system);
    assert.equal(f.errors.length, 0);
  });
}

test("Responses retry sends the same rewritten prefix without request-local tokens", async (t) => {
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

test("adapter promotes only owned standalone carriers, is idempotent and preserves unrelated fields", () => {
  const adapter = new ResponsesDelivery();
  const spoof: AgentMessage = { role: "user", content: instruction.content, timestamp: 1 };
  const metadataCanary = "legacy-transition-metadata-canary";
  const legacyInstruction = {
    ...instruction,
    details: { ...instruction.details, transitionId: metadataCanary, placement: "inline" },
  } as AgentMessage;
  const context = adapter.prepare([legacyInstruction, spoof]);
  assert.equal(context[1], spoof);
  const converted = convertToLlm(context);
  assert.equal(converted[0].role, "user");
  const input = converted.map((m: any) => ({
    role: m.role, content: [{ type: "input_text", text: typeof m.content === "string" ? m.content : m.content[0].text }],
  }));
  const payload = {
    instructions: basePrompt, input, temperature: 0.5, tools: [{ name: "unchanged" }],
    extra: { reasoning: "preserved" },
  };
  const rewritten: any = adapter.rewrite(payload);
  assert.equal(rewritten.input[0].role, "developer");
  assert.equal(rewritten.input[1], input[1]);
  assert.ok(!JSON.stringify(rewritten).includes(metadataCanary));
  assert.equal(rewritten.tools, payload.tools);
  assert.equal(rewritten.extra, payload.extra);
  assert.equal(adapter.rewrite(rewritten), rewritten);
  assert.equal(payload.input[0].role, "user");
  assert.equal(instruction.content, renderInstructions(state));
  // Simulated proxy demotion tests body preservation, NOT model compliance.
  const demoted = rewritten.input.map((item: any) => item.role === "developer" ? { ...item, role: "user" } : item);
  assert.deepEqual(demoted[0].content, rewritten.input[0].content);
});

test("malformed native shapes reject rather than partially promoting or leaking carriers", () => {
  for (const transform of [
    (_token: string): unknown => ({ messages: [] }),
    (_token: string): unknown => ({ input: [] }),
    (token: string): unknown => ({ input: [{ role: "assistant", content: [{ type: "input_text", text: token }] }] }),
    (token: string): unknown => ({ input: [{ role: "user", content: [{ type: "input_text", text: `prefix ${token}` }] }] }),
    (token: string): unknown => ({
      input: [{ role: "user", content: [{ type: "input_text", text: token }, { type: "input_image" }] }],
    }),
    (token: string): unknown => ({
      input: [0, 1].map(() => ({ role: "user", content: [{ type: "input_text", text: token }] })),
    }),
    (token: string): unknown => ({
      input: [{ role: "user", content: [{ type: "input_text", text: token }] }], extra: token,
    }),
  ]) {
    const adapter = new ResponsesDelivery();
    const carrier = adapter.prepare([instruction])[0];
    assert.ok(isInstruction(carrier));
    assert.throws(() => adapter.rewrite(transform(carrier.content)));
  }
  assert.equal(supportsNativeDelivery(), false);
  for (const api of ["anthropic-messages", "openai-completions", "google-generative-ai"]) {
    assert.equal(supportsNativeDelivery({ ...model(), api }), false);
  }
});

for (const [api, transport] of [
  ["openai-codex-responses", "sse"],
  ["openai-codex-responses", "websocket"],
  ["openai-responses", "sse"],
] as const) {
  test(`${api}/${transport}: actual runner aborts malformed payload before any transport invocation`, async (t) => {
    let sockets = 0;
    t.mock.method(globalThis, "WebSocket", function () {
      sockets++;
      throw new Error("Unexpected WebSocket connection");
    });
    const f = await fixture({
      model: model(api), transport,
      before: [(pi) => pi.on("before_provider_request", () => ({ malformed: true }))],
    });
    t.after(() => f.session.dispose());
    await f.prompt("/plan research");
    assert.equal(f.requests.length, 0);
    assert.equal(sockets, 0);
    assert.equal(f.session.messages.at(-1)?.role, "assistant");
    const last = f.session.messages.at(-1);
    assert.ok(last?.role === "assistant");
    assert.equal(last.stopReason, "aborted");
    assert.equal(f.notifications.length, 1);
    assert.equal(f.notifications[0].level, "error");
    assert.equal(inferState(f.sm.getBranch())?.mode, "plan");
    assert.equal(f.errors.length, 0); // no reliance on a swallowed hook throw
  });
}
