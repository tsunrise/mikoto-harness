import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
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
import { getCanonicalPath } from "../src/canonical-path.ts";

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
    const writeInput = {
      path: "src/file.ts",
      content: "content",
    };
    assert.equal(await call("write", writeInput), undefined);
    assert.equal(writeInput.path, path.join(cwd, "src", "file.ts"));

    const readInput = { path: "public/file.ts" };
    assert.equal(await call("read", readInput), undefined);
    assert.equal(
      readInput.path,
      path.join(cwd, "public", "file.ts"),
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

  it("pins an approved canonical path into the native tool input", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "mikoto-policy-native-"),
    );
    try {
      const target = path.join(cwd, "target");
      const replacement = path.join(cwd, "replacement");
      const alias = path.join(cwd, "alias");
      await mkdir(target);
      await mkdir(replacement);
      await symlink(target, alias);

      const handler = registerHandler(
        { filesystem: { allowWrite: ["target"] } },
        path.join(cwd, "missing-global.json"),
      );
      const ctx = {
        cwd,
        hasUI: false,
        isProjectTrusted: () => true,
      } as ExtensionContext;
      const input = {
        path: "alias/file.txt",
        content: "content",
      };
      const event = {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "write",
        input,
      } as ToolCallEvent;

      assert.equal(await handler(event, ctx), undefined);
      assert.equal(
        input.path,
        getCanonicalPath(path.join(target, "file.txt")),
      );

      await rm(alias);
      await symlink(replacement, alias);
      assert.equal(
        input.path,
        getCanonicalPath(path.join(target, "file.txt")),
      );

      const redirectedInput = {
        path: "alias/other.txt",
        content: "content",
      };
      const redirectedEvent = {
        type: "tool_call",
        toolCallId: "call-2",
        toolName: "write",
        input: redirectedInput,
      } as ToolCallEvent;
      assert.deepEqual(await handler(redirectedEvent, ctx), {
        block: true,
        reason:
          `Mikoto Policy denied this tool call. See ${
            fileURLToPath(
              new URL("../PERMISSION.md", import.meta.url),
            )
          }.`,
      });
      assert.equal(redirectedInput.path, "alias/other.txt");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ignores unrelated tools", async () => {
    const cwd = "/mikoto-policy-native-test/project";
    const handler = registerHandler({});
    const ctx = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
    } as ExtensionContext;

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
  });
});
