import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  convertToLlm, DefaultResourceLoader, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { formatContext, type CaptureResult } from "../src/context.ts";
import type { Snapshot } from "../src/protocol.ts";

const sample: Snapshot = {
  filePath: "/workspace/file", workspacePath: "/workspace", truncated: false,
  selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 4 }, text: "live" }],
};

function harness(options: Parameters<typeof extension>[1] = {}) {
  const handlers = new Map<string, (...args: any[]) => any>();
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  const notices: string[] = [];
  const ctx = {
    cwd: "/workspace", hasUI: true, signal: undefined,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;
  extension({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
  } as unknown as ExtensionAPI, {
    env: { MIKOTO_VSCODE_CONTEXT_SOCKET: "/tmp/test.sock" }, platform: "linux",
    request: async () => ({ version: 1, status: "ok" }),
    capture: async () => ({ status: "context", formatted: formatContext(sample)! }),
    ...options,
  });
  return { ctx, notices, command, handlers, emit: (name: string) => handlers.get(name)!({}, ctx) };
}

test("one live initialization handshake, fresh capture per hook, hidden persistence and provider-neutral conversion", async () => {
  let handshakes = 0;
  let captures = 0;
  const h = harness({
    request: async () => { handshakes++; return { version: 1, status: "ok" }; },
    capture: async () => {
      captures++;
      return { status: "context", formatted: formatContext({ ...sample, filePath: `/workspace/${captures}` })! };
    },
  });
  await h.emit("session_start");
  const first = (await h.emit("before_agent_start")).message;
  const second = (await h.emit("before_agent_start")).message;
  assert.notEqual(first.content, second.content);
  assert.equal(first.display, false);
  assert.equal(first.customType, "vscode-context");
  const session = SessionManager.inMemory("/workspace");
  session.appendCustomMessageEntry(first.customType, first.content, first.display, first.details);
  const history = session.buildSessionContext().messages;
  const llm = convertToLlm(history);
  assert.equal(llm[0].role, "user");
  assert.deepEqual(llm[0].content, [{ type: "text", text: first.content }]);
  await h.command("toggle", h.ctx);
  assert.equal(await h.emit("before_agent_start"), undefined);
  await h.emit("session_shutdown");
  await h.emit("session_start");
  assert.equal(await h.emit("before_agent_start"), undefined);
  assert.equal(handshakes, 1);
  assert.deepEqual(session.buildSessionContext().messages, history);
  assert.equal(h.handlers.has("context"), false);
  await h.command("toggle", h.ctx);
  assert.equal(handshakes, 2);
  assert.ok(await h.emit("before_agent_start"));
});

test("off preview does not fetch; failed handshake leaves off; valid preview uses same capture without persistence", async () => {
  let live = false;
  let captures = 0;
  const h = harness({
    request: async () => { if (!live) throw new Error("disconnected"); return { version: 1, status: "ok" }; },
    capture: async () => { captures++; return { status: "context", formatted: formatContext(sample)! }; },
  });
  await h.emit("session_start");
  await h.command("preview", h.ctx);
  await h.command("toggle", h.ctx);
  assert.equal(await h.emit("before_agent_start"), undefined);
  assert.equal(captures, 0);
  live = true;
  await h.command("toggle", h.ctx);
  await h.command(" preview ", h.ctx);
  assert.equal(captures, 1);
  assert.ok(h.notices.at(-1)?.includes(sample.filePath));
  await h.command("preview extra", h.ctx);
  assert.equal(captures, 1);
  const priorNotices = h.notices.length;
  h.ctx.hasUI = false;
  await h.command("preview", h.ctx);
  assert.equal(h.notices.length, priorNotices);
});

test("session changes, toggle-off, and abort suppress late captures even if a dependency ignores cancellation", async () => {
  for (const reason of ["shutdown", "start", "toggle", "abort"]) {
    let resolve!: (result: CaptureResult) => void;
    let started!: () => void;
    const capturing = new Promise<void>(r => { started = r; });
    const h = harness({ capture: async () => {
      started();
      return new Promise<CaptureResult>(r => { resolve = r; });
    } });
    const controller = new AbortController();
    h.ctx.signal = controller.signal;
    await h.emit("session_start");
    const pending = h.emit("before_agent_start");
    await capturing;
    if (reason === "shutdown") await h.emit("session_shutdown");
    if (reason === "start") await h.emit("session_start");
    if (reason === "toggle") await h.command("toggle", h.ctx);
    if (reason === "abort") controller.abort();
    resolve({ status: "context", formatted: formatContext(sample)! });
    assert.equal(await pending, undefined);
  }
});

test("missing endpoint stays off; transient capture failure skips silently without changing enabled choice", async () => {
  const absent = harness({ env: {} });
  await absent.emit("session_start");
  assert.equal(await absent.emit("before_agent_start"), undefined);
  let live = false;
  const h = harness({ capture: async () => live
    ? { status: "context", formatted: formatContext(sample)! }
    : { status: "unavailable" } });
  await h.emit("session_start");
  assert.equal(await h.emit("before_agent_start"), undefined);
  assert.equal(h.notices.length, 0);
  live = true;
  assert.ok(await h.emit("before_agent_start"));
});

test("a prompt waiting for initialization cannot capture after session replacement", async () => {
  let finish!: () => void;
  let started!: () => void;
  const handshaking = new Promise<void>(resolve => { started = resolve; });
  let captures = 0;
  const h = harness({
    request: async () => {
      started();
      await new Promise<void>(resolve => { finish = resolve; });
      return { version: 1, status: "ok" };
    },
    capture: async () => { captures++; return { status: "empty" }; },
  });
  const initializing = h.emit("session_start");
  await handshaking;
  const prompt = h.emit("before_agent_start");
  await h.emit("session_shutdown");
  finish();
  await initializing;
  assert.equal(await prompt, undefined);
  assert.equal(captures, 0);
});

test("Pi's real resource loader loads the package entrypoint and registers the command without tools", async t => {
  const directory = await mkdtemp("/tmp/mikoto-loader-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packagePath = fileURLToPath(new URL("../", import.meta.url));
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory,
    settingsManager: SettingsManager.inMemory({ packages: [packagePath] }),
    noContextFiles: true, noPromptTemplates: true, noThemes: true, noSkills: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find(entry => entry.path.startsWith(packagePath));
  assert.ok(extension);
  assert.equal(extension.commands.has("vscode"), true);
  assert.equal(extension.tools.size, 0);
});
