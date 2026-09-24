import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { MikotoEscalationResult } from "mikoto-types";
import {
  MikotoPolicyDocumentLoader,
  type MikotoPolicyConfig,
} from "../src/config.ts";
import { enforcePiBuiltInTools } from "../src/built-in-tools.ts";
import { getCanonicalPath } from "../src/canonical-path.ts";
import type {
  EscalationBroker,
  EscalationRequest,
} from "../src/escalate/broker.ts";

type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>;

const TOOL_NAMES = ["read", "grep", "find", "ls", "write", "edit"];

function registerHandler(
  policy: MikotoPolicyConfig,
  options: {
    readonly globalConfigPath?: string;
    readonly request?: (
      request: EscalationRequest,
    ) => Promise<MikotoEscalationResult>;
    readonly sources?: Readonly<Record<string, string>>;
  } = {},
) {
  let handler: ToolCallHandler | undefined;
  const requests: EscalationRequest[] = [];
  const pi = {
    getAllTools: () => TOOL_NAMES.map((name) => ({
      name,
      sourceInfo: {
        path: `<builtin:${name}>`,
        source: options.sources?.[name] ?? "builtin",
      },
    })),
    on(eventName: string, registeredHandler: ToolCallHandler) {
      assert.equal(eventName, "tool_call");
      handler = registeredHandler;
    },
  } as unknown as ExtensionAPI;
  const broker = {
    lifetime: () => () => {},
    request(request: EscalationRequest) {
      requests.push(request);
      return options.request?.(request) ??
        Promise.resolve({ decision: "approve" as const });
    },
  } as EscalationBroker;

  enforcePiBuiltInTools(
    new MikotoPolicyDocumentLoader(
      policy,
      options.globalConfigPath ??
        "/mikoto-policy-built-in-test/global.json",
    ),
    broker,
    pi,
  );
  assert.ok(handler);
  return { handler, requests };
}

function context(cwd: string): ExtensionContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
  } as ExtensionContext;
}

function call(
  handler: ToolCallHandler,
  ctx: ExtensionContext,
  toolName: string,
  input: Record<string, unknown>,
) {
  return handler({
    type: "tool_call",
    toolCallId: `call-${toolName}`,
    toolName,
    input,
  } as ToolCallEvent, ctx);
}

describe("enforcePiBuiltInTools", () => {
  it("reviews canonical full inputs and refuses mutations made while approval is pending", async () => {
    const cwd = "/mikoto-policy-built-in-test/exact";
    for (const [name, input] of [
      ["read", { path: "file", offset: 7, limit: 9 }],
      ["write", { path: "file", content: "captured\nvalue" }],
      ["edit", { path: "file", edits: [{ oldText: "old", newText: "new" }] }],
    ] as const) {
      const mutable = structuredClone(input) as { path: string; content?: string;
        edits?: { oldText: string; newText: string }[]; offset?: number; limit?: number };
      const original = structuredClone(input);
      const { handler, requests } = registerHandler({ filesystem: { denyRead: ["."], allowWrite: [] } }, {
        async request(review) {
          assert.deepEqual(review.action.input, { ...original, path: path.join(cwd, "file") });
          if (mutable.edits) mutable.edits[0]!.newText = "changed";
          else if ("content" in mutable) mutable.content = "changed";
          else mutable.limit = 99;
          return { decision: "approve" };
        },
      });
      const result = await call(handler, context(cwd), name, mutable);
      assert.equal(result?.block, true);
      assert.equal(requests.length, 1);
    }
  });

  it("automatically escalates filesystem policy violations", async () => {
    const cwd = "/mikoto-policy-built-in-test/project";
    const { handler, requests } = registerHandler({
      filesystem: {
        denyRead: ["secrets"],
        allowWrite: ["."],
        denyWrite: ["readonly"],
      },
    });
    const signal = new AbortController().signal;
    const ctx = { ...context(cwd), signal } as ExtensionContext;
    const denied = [
      ["read", { path: "secrets/file" }],
      ["write", { path: "readonly/file", content: "value" }],
      ["edit", { path: "secrets/other", edits: [] }],
      ["edit", { path: "readonly/other", edits: [] }],
    ] as const;

    for (const [toolName, input] of denied) {
      const expectedPath = path.resolve(cwd, input.path);
      assert.equal(await call(handler, ctx, toolName, input), undefined);
      assert.equal(input.path, expectedPath);
    }
    assert.deepEqual(
      requests.map((request) => request.action.toolName),
      denied.map(([toolName]) => toolName),
    );
    assert.deepEqual(requests[0], {
      requestId: "call-read",
      source: "Mikoto Policy",
      action: { toolName: "read", input: { path: path.join(cwd, "secrets/file") },
        context: { cwd, access: { allowed: false, deniedPath: path.join(cwd, "secrets") } } },
      why: "This operation requires filesystem access denied by the current policy.",
      signal,
    });
    assert.ok(requests.every((request) =>
      request.why ===
        "This operation requires filesystem access denied by the current policy."
    ));

    const requestCount = requests.length;
    assert.equal(
      await call(handler, ctx, "read", { path: "public/file" }),
      undefined,
    );
    assert.equal(requests.length, requestCount);
    assert.equal(
      await call(handler, ctx, "bash", { command: "cat secrets/file" }),
      undefined,
    );
  });

  it("denies non-escalatable built-in policy violations without prompting", async () => {
    const cwd = "/mikoto-policy-built-in-test/project";
    const { handler, requests } = registerHandler({
      filesystem: {
        denyRead: ["secrets"],
        allowWrite: ["."],
      },
    });
    const ctx = context(cwd);

    for (const [toolName, input] of [
      ["grep", { path: "secrets" }],
      ["find", { path: "secrets" }],
      ["ls", { path: "secrets" }],
    ] as const) {
      const result = await call(handler, ctx, toolName, input);
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? "", /denied this tool call/);
      assert.equal(input.path, "secrets");
    }
    assert.equal(requests.length, 0);
  });

  it("preserves the denial reason without attributing delegated rejection to a human", async () => {
    const cwd = "/mikoto-policy-built-in-test/project";
    const { handler } = registerHandler(
      { filesystem: { denyRead: ["secrets"] } },
      {
        request: async () => ({
          decision: "reject",
          cause: "user",
          reason: "Keep this private",
        }),
      },
    );

    const result = await call(
      handler,
      context(cwd),
      "read",
      { path: "secrets/file" },
    );
    assert.equal(result?.block, true);
    assert.ok(result?.reason?.includes("Keep this private"));
    assert.ok(!result?.reason?.includes("(user)"));
  });

  it("pins an allowed canonical path into the built-in tool input", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "mikoto-policy-built-in-"),
    );
    try {
      const target = path.join(cwd, "target");
      const alias = path.join(cwd, "alias");
      await mkdir(target);
      await symlink(target, alias);
      const { handler, requests } = registerHandler(
        { filesystem: { allowWrite: ["target"] } },
        { globalConfigPath: path.join(cwd, "missing-global.json") },
      );
      const input = { path: "alias/file.txt", edits: [] };

      assert.equal(
        await call(handler, context(cwd), "edit", input),
        undefined,
      );
      assert.equal(
        input.path,
        getCanonicalPath(path.join(target, "file.txt")),
      );
      assert.equal(requests.length, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("denies an approved request if its canonical target changes while waiting", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "mikoto-policy-built-in-race-"),
    );
    try {
      const denied = path.join(cwd, "denied");
      const allowed = path.join(cwd, "allowed");
      await mkdir(denied);
      await mkdir(allowed);
      let approve!: (result: MikotoEscalationResult) => void;
      const decision = new Promise<MikotoEscalationResult>((resolve) => {
        approve = resolve;
      });
      let enteredApproval!: () => void;
      const approvalEntered = new Promise<void>((resolve) => { enteredApproval = resolve; });
      const { handler } = registerHandler(
        { filesystem: { denyRead: ["denied"] } },
        {
          globalConfigPath: path.join(cwd, "missing-global.json"),
          request: async () => { enteredApproval(); return decision; },
        },
      );
      const input = { path: "denied/file" };
      const pending = call(handler, context(cwd), "read", input);
      // Wait for the actual authorization boundary, not one event-loop tick:
      // policy file loading can take longer on a busy filesystem.
      await approvalEntered;
      await rename(denied, path.join(cwd, "old-denied"));
      await symlink(allowed, denied);
      approve({ decision: "approve" });

      const result = await pending;
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? "", /target changed during authorization/);
      assert.equal(input.path, "denied/file");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for conflicting same-name tools", async () => {
    const { handler, requests } = registerHandler(
      {},
      { sources: { read: "sdk" } },
    );
    const result = await call(
      handler,
      context("/mikoto-policy-built-in-test/project"),
      "read",
      { path: "file" },
    );

    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /conflicting read ownership/);
    assert.equal(requests.length, 0);
  });
});
