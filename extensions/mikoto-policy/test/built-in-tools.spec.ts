import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { MikotoPolicyConfig } from "../src/config.ts";
import { enforcePiNativeTools } from "../src/built-in-tools.ts";

type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>;

function registerHandler(policy: MikotoPolicyConfig): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  const pi = {
    on(eventName: string, registeredHandler: ToolCallHandler) {
      assert.equal(eventName, "tool_call");
      handler = registeredHandler;
    },
  } as unknown as ExtensionAPI;

  enforcePiNativeTools(policy, pi);
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
    const ctx = { cwd } as ExtensionContext;
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
});
