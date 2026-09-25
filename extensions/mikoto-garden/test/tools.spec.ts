import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Delivery, Job, Requests } from "../src/protocol.ts";
import { registerGardenTools, type ToolRuntime } from "../src/tools.ts";

type FixtureOptions = {
  job?: Partial<Job>;
  jobs?: Job[];
  emit?: (name: string, event: unknown) => void;
};
function fixture(onRequest: (method: keyof Requests) => void = () => {}, options: FixtureOptions = {}) {
  const tools = new Map<string, ToolDefinition>();
  const requests: { method: keyof Requests; data: unknown; timeout?: number }[] = [];
  const job: Job = {
    id: 123, mode: "sandboxed", state: "running", cmd: "/bin/cat",
    cwd: process.cwd(), started: 0, disclosed: true, stdinOpen: true,
    exit_code: null, exit_signal: null, unread: 0, ...options.job,
  };
  const delivery: Delivery = {
    job: { ...job, state: "exited", exit_code: 0, stdinOpen: false },
    chunk: "fixture", output: "done", omitted: 0, log: "/fixture/log",
    logCapped: false, wall_ms: 1, yielded: false, capabilities: false, request: 99,
  };
  const runtime: ToolRuntime = {
    generation: "fixture", lifetime: new AbortController(),
    endpoint: () => undefined, approvals: new Map(),
    client: {
      async request(method: keyof Requests, data: unknown, timeout?: number) {
        requests.push({ method, data, timeout });
        onRequest(method);
        if (method === "list") return { jobs: options.jobs ?? [job] };
        if (method === "spawn" || method === "input") return delivery;
        if (method === "preflight" || method === "ack" || method === "cancel" || method === "stop") return null;
        assert.fail(`Unexpected request: ${method}`);
      },
    } as unknown as ToolRuntime["client"],
  };
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    events: {
      emit: options.emit ?? (() => assert.fail("Sandboxed operations must not request approval")),
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(), thinkingLevel: "off",
    sessionManager: { getSessionId: () => "fixture", getSessionFile: () => undefined },
  } as unknown as ExtensionContext;
  const collected: number[] = [];
  registerGardenTools(pi, () => runtime, (id) => collected.push(id));
  return {
    tools,
    requests,
    delivery,
    collected,
    execute: (name: string, args: Record<string, unknown>, signal?: AbortSignal, update?: AgentToolUpdateCallback) =>
      tools.get(name)!.execute("fixture", args, signal, update, ctx),
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
  for (const name of ["exec_command", "write_stdin", "list_commands", "stop_command"]) {
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

test("initial cancellation stops an undisclosed job; an arrived input handoff is still accepted", async () => {
  for (const name of ["exec_command", "write_stdin"]) {
    const controller = new AbortController();
    const h = fixture((method) => {
      if (method === "spawn" || method === "input") controller.abort();
    });
    h.delivery.job.disclosed = name !== "exec_command";
    const result = h.execute(name, name === "exec_command" ? { cmd: "true" } : { session_id: 123 }, controller.signal);
    if (name === "exec_command") {
      await assert.rejects(result, /abort/i);
      assert.deepEqual(h.requests.slice(-2).map(({ method }) => method), ["cancel", "stop"]);
      assert.deepEqual(h.collected, []);
    } else {
      await result;
      assert.equal(h.requests.at(-1)!.method, "ack");
      assert.deepEqual(h.collected, [123]);
    }
  }
});

test("both tools release failed handoffs and ACK log retention before reporting collection", async () => {
  for (const name of ["exec_command", "write_stdin"]) {
    const args = name === "exec_command" ? { cmd: "true" } : { session_id: 123 };
    const failed = fixture((method) => {
      if (method === "ack") throw new Error("ACK failed");
    });
    failed.delivery.job.disclosed = name !== "exec_command";
    await assert.rejects(failed.execute(name, args), /ACK failed/);
    assert.deepEqual(failed.requests.find(({ method }) => method === "cancel")?.data, { request: 99 });
    assert.equal(failed.requests.some(({ method }) => method === "stop"), name === "exec_command");
    assert.deepEqual(failed.collected, []);

    const accepted = fixture();
    accepted.delivery.omitted = 10;
    await accepted.execute(name, args);
    assert.deepEqual(accepted.requests.at(-1)?.data, { id: 123, chunk: "fixture", preserveLog: true });
    assert.deepEqual(accepted.collected, [123]);
  }
});

type EscalateEvent = {
  action: { toolName: string; input: Record<string, unknown> };
  claim(): boolean;
  callback(result: { decision: "approve" | "reject"; cause?: string }): void;
};
const broker = (decision: "approve" | "reject", seen: EscalateEvent[] = []) =>
  (name: string, event: unknown) => {
    assert.equal(name, "mikoto-policy:escalate");
    const escalation = event as EscalateEvent;
    seen.push(escalation);
    assert.equal(escalation.claim(), true);
    escalation.callback(decision === "approve" ? { decision } : { decision, cause: "user" });
  };

test("stop_command stops a live sandboxed command and collects its final output without approval", async () => {
  const h = fixture();
  const result = await h.execute("stop_command", { session_id: 123 });
  assert.deepEqual(h.requests.map(({ method }) => method), ["list", "stop", "input", "ack"]);
  assert.deepEqual(h.requests[1].data, { id: 123 });
  const collect = h.requests[2].data as Requests["input"];
  assert.deepEqual(collect.operation, { kind: "poll", chars: "" });
  assert.equal(collect.wait, 1_000);
  assert.equal((result.details as Delivery).output, "done");
  assert.deepEqual(h.collected, [123]);
});

test("stop_command collects an already-finished command without signalling or approval", async () => {
  for (const job of [
    { state: "exited" as const, exit_code: 0 },
    { state: "exited" as const, exit_code: 0, mode: "unsandboxed" as const },
  ]) {
    const h = fixture(undefined, { job });
    const args = job.mode ? { session_id: 123, justification: "clean up" } : { session_id: 123 };
    await h.execute("stop_command", args);
    assert.deepEqual(h.requests.map(({ method }) => method), ["list", "input", "ack"]);
  }
});

test("stop_command requires approval to stop a live unsandboxed command", async () => {
  const seen: EscalateEvent[] = [];
  const approved = fixture(undefined, { job: { mode: "unsandboxed" }, emit: broker("approve", seen) });
  await approved.execute("stop_command", { session_id: 123, justification: "hung login" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action.toolName, "stop_command");
  assert.equal(seen[0].action.input.session_id, 123);
  assert.deepEqual(approved.requests.map(({ method }) => method), ["list", "stop", "input", "ack"]);

  const rejected = fixture(undefined, { job: { mode: "unsandboxed" }, emit: broker("reject") });
  await assert.rejects(
    rejected.execute("stop_command", { session_id: 123, justification: "hung login" }),
    /rejected/,
  );
  assert.deepEqual(rejected.requests.map(({ method }) => method), ["list"]);
});

test("stop_command rejects a justification mismatch before signalling", async () => {
  for (const [job, args] of [
    [{}, { session_id: 123, justification: "not needed" }],
    [{ mode: "unsandboxed" as const }, { session_id: 123 }],
  ] as const) {
    const h = fixture(undefined, { job });
    await assert.rejects(h.execute("stop_command", args), /Justification/);
    assert.deepEqual(h.requests.map(({ method }) => method), ["list"]);
  }
});

test("write_stdin and stop_command cannot target a job whose ID exec_command has not returned", async () => {
  for (const [name, args] of [
    ["write_stdin", { session_id: 123 }],
    ["write_stdin", { session_id: 123, chars: "data" }],
    ["stop_command", { session_id: 123 }],
  ] as const) {
    const h = fixture(undefined, { job: { disclosed: false } });
    await assert.rejects(h.execute(name, args), /Unknown or expired/);
    assert.deepEqual(h.requests.map(({ method }) => method), ["list"]);
    assert.deepEqual(h.collected, []);
  }
});

test("list_commands reports one row per command whose session ID was returned", async () => {
  const base: Job = {
    id: 0, mode: "sandboxed", state: "running", cmd: "sleep 1\nsleep 2",
    cwd: process.cwd(), started: 0, disclosed: true, stdinOpen: false,
    exit_code: null, exit_signal: null, unread: 0,
  };
  const jobs: Job[] = [
    { ...base, id: 111111 },
    { ...base, id: 222222, disclosed: false },
    { ...base, id: 333333, state: "exited", exit_code: 1, ended: 5 },
  ];
  const h = fixture(undefined, { jobs });
  const result = await h.execute("list_commands", {});
  assert.deepEqual(h.requests.map(({ method }) => method), ["list"]);
  assert.deepEqual((result.details as { jobs: Job[] }).jobs.map(({ id }) => id), [111111, 333333]);
  const text = (result.content[0] as { text: string }).text;
  assert.equal(text.split("\n").length, 2);
  assert.match(text, /\b111111\b/);
  assert.match(text, /\b333333\b/);
  assert.doesNotMatch(text, /\b222222\b/);

  const empty = fixture(undefined, { jobs: [] });
  assert.deepEqual(((await empty.execute("list_commands", {})).details as { jobs: Job[] }).jobs, []);
});
