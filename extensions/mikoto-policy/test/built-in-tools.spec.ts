import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  MikotoPolicyDocumentLoader,
  type MikotoPolicyConfig,
} from "../src/config.ts";
import { enforcePiNativeTools } from "../src/built-in-tools.ts";

type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>;

function registerHandler(
  policy: MikotoPolicyConfig,
  globalConfigPath = "/mikoto-policy-native-test/global.json",
): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  const pi = {
    on(eventName: string, registeredHandler: ToolCallHandler) {
      assert.equal(eventName, "tool_call");
      handler = registeredHandler;
    },
  } as unknown as ExtensionAPI;

  enforcePiNativeTools(
    new MikotoPolicyDocumentLoader(policy, globalConfigPath),
    pi,
  );
  assert.ok(handler);
  return handler;
}

describe("enforcePiNativeTools", () => {
  it("enforces path-based native tool calls", async () => {
    const cwd = "/mikoto-policy-native-test/project";
    const handler = registerHandler({
      filesystem: {
        denyRead: ["secrets"],
        allowWrite: ["."],
        denyWrite: ["readonly"],
      },
    });
    const ctx = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
    } as ExtensionContext;
    const call = (
      toolName: string,
      input: Record<string, unknown>,
    ) => handler(
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName,
        input,
      } as ToolCallEvent,
      ctx,
    );
    const permissionPath = fileURLToPath(
      new URL("../PERMISSION.md", import.meta.url),
    );
    const blocked = {
      block: true,
      reason:
        `Mikoto Policy denied this tool call. See ${permissionPath}.`,
    };

    assert.deepEqual(
      await call("read", { path: "secrets/token.txt" }),
      blocked,
    );
    for (const toolName of ["grep", "find", "ls"]) {
      assert.deepEqual(
        await call(toolName, { path: "secrets" }),
        blocked,
      );
    }
    assert.equal(
      await call("write", {
        path: "src/file.ts",
        content: "content",
      }),
      undefined,
    );
    assert.deepEqual(
      await call("write", {
        path: "readonly/file.ts",
        content: "content",
      }),
      blocked,
    );
    assert.deepEqual(
      await call("edit", {
        path: "secrets/token.txt",
        edits: [],
      }),
      blocked,
    );
    assert.equal(
      await call("bash", { command: "cat secrets/token.txt" }),
      undefined,
    );
  });

  it("warns once when an untrusted workspace policy is skipped", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "mikoto-policy-native-"),
    );
    try {
      await writeFile(
        path.join(cwd, "mikoto-policy.json"),
        JSON.stringify({
          filesystem: {
            allowWrite: ["/"],
          },
        }),
      );
      const handler = registerHandler(
        { filesystem: { allowWrite: ["."] } },
        path.join(cwd, "missing-global.json"),
      );
      const notifications: string[] = [];
      const ctx = {
        cwd,
        hasUI: true,
        isProjectTrusted: () => false,
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionContext;
      const event = {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "write",
        input: {
          path: "file.txt",
          content: "content",
        },
      } as ToolCallEvent;

      assert.equal(await handler(event, ctx), undefined);
      assert.equal(await handler(event, ctx), undefined);
      assert.deepEqual(notifications, [
        `Mikoto Policy skipped ${path.join(cwd, "mikoto-policy.json")} because the workspace is not trusted.`,
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writes warnings to stderr without UI and ignores unrelated tools", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "mikoto-policy-native-"),
    );
    const globalConfigPath = path.join(cwd, "global.json");
    await writeFile(globalConfigPath, "{");
    const handler = registerHandler(
      { filesystem: { allowWrite: ["."] } },
      globalConfigPath,
    );
    const ctx = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
    } as ExtensionContext;
    const warnings: string[] = [];
    const originalConsoleError = console.error;
    console.error = (warning: string) => {
      warnings.push(warning);
    };

    try {
      assert.equal(
        await handler(
          {
            type: "tool_call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "pwd" },
          } as ToolCallEvent,
          ctx,
        ),
        undefined,
      );
      assert.deepEqual(warnings, []);

      assert.equal(
        await handler(
          {
            type: "tool_call",
            toolCallId: "call-2",
            toolName: "read",
            input: { path: "file.txt" },
          } as ToolCallEvent,
          ctx,
        ),
        undefined,
      );
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /ignored invalid policy/);
    } finally {
      console.error = originalConsoleError;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
