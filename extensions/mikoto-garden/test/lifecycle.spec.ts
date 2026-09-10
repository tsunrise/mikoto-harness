import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, access, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, mock } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MikotoPolicy, MikotoPolicyEscalateEvent } from "mikoto-types";
import garden from "../src/index.ts";
import { CapabilityServer } from "../src/capability-server.ts";
import { ExecutorClient } from "../src/executor-client.ts";
import { shellQuote } from "../src/launch.ts";
import { renderGardenPrompt } from "../src/prompt.ts";
import type { Delivery } from "../src/protocol.ts";

type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;
async function fixture(body: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>) {
  const parent = fileURLToPath(new URL("../test-runtime/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const dir = await realpath(await mkdtemp(join(parent, "lifecycle-")));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  const h = await harness(dir);
  try { await body(h); }
  finally {
    await h.emit("session_shutdown");
    mock.restoreAll();
    if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
    await rm(dir, { recursive: true, force: true });
  }
}
async function harness(dir: string) {
  const bus = new EventEmitter();
  const hooks = new Map<string, Hook[]>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  let active = ["bash", "read", "exec_command", "write_stdin", "other"];
  const notices: string[] = [];
  const ctx = {
    cwd: dir, mode: "tui", hasUI: true, thinkingLevel: "off",
    sessionManager: { getSessionId: () => "fixture", getSessionFile: () => undefined },
    ui: { notify: (text: string) => notices.push(text), setStatus() {} },
  } as unknown as ExtensionContext;
  const pi = {
    events: {
      emit: bus.emit.bind(bus),
      on(name: string, handler: (...args: unknown[]) => void) {
        bus.on(name, handler); return () => { bus.off(name, handler); };
      },
    },
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    on(name: string, handler: Hook) { const entries = hooks.get(name) ?? []; entries.push(handler); hooks.set(name, entries); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) { commands.set(name, command); },
  } as unknown as ExtensionAPI;
  const policy: MikotoPolicy = {
    document: () => Object.freeze({
      filesystem: Object.freeze({ denyRead: [], allowRead: [], allowWrite: [dir], denyWrite: [] }),
      network: Object.freeze({ allowedDomains: [], deniedDomains: ["*"] }),
    }),
    diagnostics: () => [], permissionMdPath: "/test-policy",
    resolveToolPath: (p) => p, canonicalizePath: realpath,
    evaluateRead: async () => ({ allowed: true }), evaluateReadTree: async () => ({ allowed: true }),
    evaluateWrite: async () => ({ allowed: false, deniedPath: dir }),
  };
  bus.on("mikoto-policy:get-policy", (event) => event.callback(policy));
  garden(pi);
  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    const results = [];
    for (const hook of hooks.get(name) ?? []) results.push(await hook(event, ctx));
    return results;
  };
  const exec = (args: Record<string, unknown>, signal?: AbortSignal) => tools.get("exec_command")!.execute("fixture", args, signal, undefined, ctx);
  return { dir, bus, tools, commands, ctx, pi, policy, hooks, notices, emit, exec, active: () => active };
}
test("real tool ACK retires jobs but preserves formatter-only omission logs; generation replacement starts empty", {
  skip: process.platform !== "darwin", timeout: 30000,
}, async () => {
  await fixture(async (h) => {
    await h.emit("session_start");
    const ps = async () => {
      await h.commands.get("ps")!.handler("", { ...h.ctx, mode: "rpc" } as ExtensionCommandContext);
      return h.notices.at(-1)!;
    };
    const input = (session_id: number) => h.tools.get("write_stdin")!.execute("collect", { session_id }, undefined, undefined, h.ctx);
    assert.match(await ps(), /No managed processes/);
    const result = await h.exec({
      cmd: `${shellQuote(process.execPath)} -e 'process.stdout.write("x\\n".repeat(1998))'`, login: false,
    });
    const details = result.details as Delivery;
    assert.ok(details.omitted > 0);
    assert.equal(await readFile(details.log, "utf8"), "x\n".repeat(1998));
    assert.match(await ps(), /No managed processes/);
    await assert.rejects(input(details.job.id), /Unknown or expired/);
    const live = await h.exec({ cmd: "sleep 11; printf uncollected", login: false, yield_time_ms: 0 });
    const id = (live.details as Delivery).job.id;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.match(await ps(), new RegExp(String(id)));
    await h.emit("session_start");
    assert.match(await ps(), /No managed processes/);
    await assert.rejects(input(id), /Unknown or expired/);
    await assert.rejects(access(details.log), { code: "ENOENT" }, "normal generation teardown still removes runtime logs");
  });
});
test("capability startup failure preserves both execution modes and stable prompt", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  await fixture(async (h) => {
    let starts = 0;
    mock.method(CapabilityServer, "start", async () => { starts++; return undefined; });
    h.bus.on("mikoto-policy:escalate", (event: MikotoPolicyEscalateEvent) => {
      if (event.claim()) void event.callback({ decision: "approve" });
    });
    await h.emit("session_start");
    assert.equal(starts, 1);
    assert.deepEqual(h.active(), ["read", "exec_command", "write_stdin", "other"]);
    assert.equal(h.hooks.has("user_bash"), false);
    const prompt = await h.emit("before_agent_start", { systemPrompt: "## Command execution\nExisting unrelated heading" });
    for (const sandbox_permissions of ["use_default", "require_escalated"]) {
      const result = await h.exec({
        cmd: 'test -z "${GARDEN_TOKEN+x}" && test -z "${GARDEN_SERVER+x}" && printf no-capabilities',
        login: false, sandbox_permissions,
        ...(sandbox_permissions === "require_escalated" ? { justification: "Fixture host environment check" } : {}),
      });
      const text = result.content[0].type === "text" ? result.content[0].text : "";
      assert.match(text, /Capabilities: unavailable/);
      assert.match(text, /Process exited with code 0/);
    }
    assert.deepEqual(await h.emit("before_agent_start", { systemPrompt: "## Command execution\nExisting unrelated heading" }), prompt);
    h.pi.setActiveTools(["bash", "other"]);
    await h.emit("before_agent_start", { systemPrompt: "" });
    assert.deepEqual(h.active(), ["other"]);
    assert.equal((await h.emit("tool_call", { toolName: "bash" }) as { block: boolean }[])[0].block, true);
  });
});
test("server loss revokes capabilities without stopping jobs; tree rotation retires IDs", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  await fixture(async (h) => {
    const start = CapabilityServer.start.bind(CapabilityServer);
    let retire!: () => void;
    mock.method(CapabilityServer, "start", async (...[registry, lost]: Parameters<typeof CapabilityServer.start>) => {
      const server = await start(registry, lost);
      retire = () => { server!.stopAdmitting(); lost(); };
      return server;
    });
    await h.emit("session_start");
    const initialPrompt = await h.emit("before_agent_start", { systemPrompt: "" });
    const sleeper = await h.exec({ cmd: "/bin/cat", stdin: true, login: false, yield_time_ms: 0 });
    const jobId = (sleeper.details as { job: { id: number } }).job.id;
    let approve!: () => void;
    let entered!: () => void;
    const approvalEntered = new Promise<void>((resolve) => { entered = resolve; });
    h.bus.on("mikoto-policy:escalate", (event: MikotoPolicyEscalateEvent) => {
      if (!event.claim()) return;
      approve = () => { void event.callback({ decision: "approve" }); }; entered();
    });
    const marker = join(h.dir, "must-not-spawn");
    const pending = h.exec({
      cmd: `touch ${shellQuote(marker)}`, login: false, sandbox_permissions: "require_escalated", justification: "Fixture race",
    });
    await approvalEntered;
    retire();
    await new Promise((resolve) => setTimeout(resolve, 100));
    approve();
    await assert.rejects(pending, /capability availability changed/i);
    await assert.rejects(access(marker));
    const nextStart = await h.emit("before_agent_start", { systemPrompt: "" });
    assert.deepEqual(nextStart, initialPrompt);
    assert.equal(h.hooks.has("context"), false, "Garden must not replace/remove messages between model requests");
    const result = await h.exec({ cmd: 'test -z "${GARDEN_TOKEN+x}" && printf fresh', login: false });
    assert.match(result.content[0].type === "text" ? result.content[0].text : "", /Capabilities: unavailable/);
    await h.emit("session_tree");
    await assert.rejects(h.tools.get("write_stdin")!.execute("old", { session_id: jobId }, undefined, undefined, h.ctx), /Unknown or expired/);
  });
});
test("agent starts inject only stable guidance, never job messages or discovery requests", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  await fixture(async (h) => {
    await h.emit("session_start");
    const baseline = await h.emit("before_agent_start", { systemPrompt: "Base prompt" });
    assert.deepEqual(baseline, [{ systemPrompt: `Base prompt\n\n${renderGardenPrompt(h.policy.document())}` }, undefined]);
    await h.exec({ cmd: "/bin/cat", stdin: true, login: false, yield_time_ms: 250 });
    await h.exec({ cmd: "printf completed", login: false });
    const requests = mock.method(ExecutorClient.prototype, "request");
    for (let turn = 0; turn < 3; turn++) {
      assert.deepEqual(await h.emit("before_agent_start", { systemPrompt: "Base prompt" }), baseline);
    }
    assert.equal(requests.mock.callCount(), 0, "Agent start must not query jobs");
    assert.equal(h.hooks.has("context"), false, "Do not add a replacement context hook");
  });
});
test("workload-writable PATH cannot replace the wrapper's host env helper", { skip: process.platform !== "darwin", timeout: 30000 }, async () => {
  await fixture(async (h) => {
    const marker = join(h.dir, "host-helper-was-hijacked");
    const helper = join(h.dir, "env");
    await writeFile(helper, `#!/bin/sh\nprintf hijacked > ${shellQuote(marker)}\nexec /usr/bin/env "$@"\n`, { mode: 0o700 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${h.dir}:${previousPath}`;
    try {
      await h.emit("session_start");
      const result = await h.exec({ cmd: `test "$(command -v env)" = ${shellQuote(helper)}`, login: false });
      assert.match(result.content[0].type === "text" ? result.content[0].text : "", /Process exited with code 0/);
      await assert.rejects(access(marker));
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
  });
});
test("missing/invalid Policy still attempts capabilities but cannot dispatch or ask for escalation", async () => {
  await fixture(async (h) => {
    let attempts = 0;
    mock.method(CapabilityServer, "start", async () => { attempts++; return undefined; });
    h.bus.removeAllListeners("mikoto-policy:get-policy");
    h.bus.on("mikoto-policy:escalate", () => assert.fail("Invalid Policy must not enter approval"));
    for (const broken of [undefined, { ...h.policy, diagnostics() { throw new Error("Broken service"); } }]) {
      h.bus.removeAllListeners("mikoto-policy:get-policy");
      if (broken) h.bus.on("mikoto-policy:get-policy", (event) => event.callback(broken));
      await h.emit("session_start");
      for (const sandbox_permissions of ["use_default", "require_escalated"]) {
        await assert.rejects(h.exec({
          cmd: "true", sandbox_permissions,
          ...(sandbox_permissions === "require_escalated" ? { justification: "Must not reach broker" } : {}),
        }), /unavailable/i);
      }
      assert.match(
        JSON.stringify(await h.emit("before_agent_start", { systemPrompt: "" })),
        /no valid policy snapshot/i,
      );
    }
    assert.equal(attempts, 2);
  });
});
test("failed initialization reports retained-artifact warnings before discarding its client", {
  skip: process.platform !== "darwin", timeout: 5000,
}, async () => {
  await fixture(async (h) => {
    mock.method(CapabilityServer, "start", async () => undefined);
    const request = ExecutorClient.prototype.request;
    const close = ExecutorClient.prototype.close;
    mock.method(ExecutorClient.prototype, "request", async function (
      this: ExecutorClient, ...args: Parameters<ExecutorClient["request"]>
    ) {
      if (args[0] === "init") throw new Error("Fixture initialization failed");
      return request.apply(this, args);
    });
    mock.method(ExecutorClient.prototype, "close", async function (this: ExecutorClient) {
      // Keep real child teardown; add a synthetic warning rather than leaking
      // an actual runtime directory just to exercise the reporting path.
      const warnings = await close.call(this);
      return [...warnings, "Owned runtime artifacts retained: fixture"];
    });
    await h.emit("session_start");
    assert.ok(h.notices.includes("Owned runtime artifacts retained: fixture"));
    await assert.rejects(h.exec({ cmd: "true" }), /initialization failed/);
  });
});
test("duplicate event-bus facades cannot acquire a second session generation", async () => {
  await fixture(async (h) => {
    let starts = 0;
    h.bus.removeAllListeners("mikoto-policy:get-policy");
    mock.method(CapabilityServer, "start", async () => { starts++; return undefined; });
    garden({ ...h.pi, events: { ...h.pi.events } });
    await assert.rejects(h.emit("session_start"), /Duplicate/);
    assert.equal(starts, 1);
    await assert.rejects(h.emit("session_tree"), /Duplicate/);
    assert.equal(starts, 2);
  });
});
