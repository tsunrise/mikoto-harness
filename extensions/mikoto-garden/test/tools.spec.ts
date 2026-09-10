import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Delivery, Job, Requests } from "../src/protocol.ts";
import { registerGardenTools, type ToolRuntime } from "../src/tools.ts";

function fixture() {
  const tools = new Map<string, ToolDefinition>();
  const requests: { method: keyof Requests; data: unknown; timeout?: number }[] = [];
  const job: Job = {
    id: 123, mode: "sandboxed", state: "running", cmd: "/bin/cat",
    cwd: process.cwd(), started: 0, disclosed: true, stdinOpen: true,
    exit_code: null, exit_signal: null, unread: 0,
  };
  const delivery: Delivery = {
    job: { ...job, state: "exited", exit_code: 0, stdinOpen: false },
    chunk: "fixture", output: "done", omitted: 0, log: "/fixture/log",
    logCapped: false, wall_ms: 1, yielded: false, capabilities: false,
  };
  const runtime: ToolRuntime = {
    generation: "fixture", lifetime: new AbortController(),
    endpoint: () => undefined, approvals: new Map(),
    client: {
      async request(method: keyof Requests, data: unknown, timeout?: number) {
        requests.push({ method, data, timeout });
        if (method === "list") return { jobs: [job] };
        if (method === "spawn" || method === "input") return delivery;
        if (method === "preflight" || method === "ack") return null;
        assert.fail(`Unexpected request: ${method}`);
      },
    } as unknown as ToolRuntime["client"],
  };
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    events: { emit: () => assert.fail("Sandboxed operations must not request approval") },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(), thinkingLevel: "off",
    sessionManager: { getSessionId: () => "fixture", getSessionFile: () => undefined },
  } as unknown as ExtensionContext;
  registerGardenTools(pi, () => runtime);
  return {
    tools,
    requests,
    execute: (name: string, args: Record<string, unknown>) =>
      tools.get(name)!.execute("fixture", args, undefined, undefined, ctx),
  };
}

const waits = [
  { requested: undefined, exec: 10_000, poll: 10_000, input: 250 },
  { requested: 0, exec: 10_000, poll: 10_000, input: 250 },
  { requested: 1, exec: 10_000, poll: 10_000, input: 250 },
  { requested: 250, exec: 10_000, poll: 10_000, input: 250 },
  { requested: 5_000, exec: 10_000, poll: 10_000, input: 5_000 },
  { requested: 9_999, exec: 10_000, poll: 10_000, input: 9_999 },
  { requested: 10_000, exec: 10_000, poll: 10_000, input: 10_000 },
  { requested: 30_000, exec: 30_000, poll: 30_000, input: 30_000 },
  { requested: 45_000, exec: 30_000, poll: 45_000, input: 30_000 },
  { requested: 300_000, exec: 30_000, poll: 300_000, input: 30_000 },
  { requested: Number.MAX_SAFE_INTEGER, exec: 30_000, poll: 300_000, input: 30_000 },
];
const waitArgument = (value: number | undefined) =>
  value === undefined ? {} : { yield_time_ms: value };

test("model-facing tool metadata uses product-neutral wording", () => {
  const { tools } = fixture();
  for (const name of ["exec_command", "write_stdin"]) {
    const tool = tools.get(name)!;
    const modelMetadata = JSON.stringify({
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: tool.parameters,
    });
    assert.doesNotMatch(modelMetadata, /\b(?:mikoto|garden)\b/i);
  }
});

test("exec_command clamps public waits to 10–30 seconds without delaying completed results", async () => {
  for (const { requested, exec: expected } of waits) {
    const h = fixture();
    const result = await h.execute("exec_command", {
      cmd: "true", login: false, ...waitArgument(requested),
    });
    const spawn = h.requests.find((request) => request.method === "spawn")!;
    assert.equal((spawn.data as Requests["spawn"]).wait, expected);
    assert.equal(spawn.timeout, expected + 20_000, "IPC timeout must include the clamped wait");
    assert.equal((result.details as Delivery).yielded, false);
    assert.equal((result.details as Delivery).wall_ms, 1);
    assert.equal(h.requests.at(-1)!.method, "ack");
  }
});

test("write_stdin clamps every output-only poll spelling to 10–300 seconds", async () => {
  for (const { requested, poll: expected } of waits) {
    for (const input of [{}, { chars: "" }, { chars: "", close_stdin: false }]) {
      const h = fixture();
      await h.execute("write_stdin", { session_id: 123, ...input, ...waitArgument(requested) });
      const poll = h.requests.find((request) => request.method === "input")!;
      const data = poll.data as Requests["input"];
      assert.deepEqual(data.operation, { kind: "poll", chars: "" });
      assert.equal(data.wait, expected);
      assert.equal(poll.timeout, expected + 15_000);
      assert.equal(h.requests.at(-1)!.method, "ack");
    }
  }
});

test("write_stdin writes, EOF and interrupts keep their short response waits", async () => {
  const operations = [
    { args: { chars: "data" }, kind: "write" },
    { args: { chars: "data", close_stdin: true }, kind: "write-close" },
    { args: { close_stdin: true }, kind: "eof" },
    { args: { chars: "\u0003" }, kind: "interrupt" },
  ];
  for (const { requested, input: expected } of waits) {
    for (const { args, kind } of operations) {
      const h = fixture();
      await h.execute("write_stdin", { session_id: 123, ...args, ...waitArgument(requested) });
      const input = h.requests.find((request) => request.method === "input")!;
      const data = input.data as Requests["input"];
      assert.equal(data.operation.kind, kind);
      assert.equal(data.wait, expected);
      assert.equal(input.timeout, expected + 15_000);
    }
  }
});

test("invalid waits are rejected before dispatch, not repaired by clamping", async () => {
  for (const yield_time_ms of [-1, 0.5, NaN, Infinity]) {
    for (const [name, args] of [
      ["exec_command", { cmd: "true" }],
      ["write_stdin", { session_id: 123 }],
    ] as const) {
      const h = fixture();
      await assert.rejects(h.execute(name, { ...args, yield_time_ms }), /Invalid tool arguments/);
      assert.deepEqual(h.requests, []);
    }
  }
});
