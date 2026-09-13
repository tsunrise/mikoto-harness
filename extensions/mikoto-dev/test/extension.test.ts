import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import mikotoDev, {
  SYSTEM_PROMPT_DEBUG_COMMAND,
  SYSTEM_PROMPT_DEBUG_FILE,
} from "../src/index.ts";

type Command = {
  readonly description?: string;
  readonly handler: (
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
};

function setup(agentDir: string): {
  commandName: string;
  command: Command;
} {
  let commandName = "";
  let command: Command | undefined;
  const pi = {
    registerCommand(name: string, value: Command) {
      commandName = name;
      command = value;
    },
  } as unknown as ExtensionAPI;

  mikotoDev(pi, { agentDir });
  assert.ok(command);
  return { commandName, command };
}

function commandContext(
  getPrompt: () => string,
  notifications: Array<{ message: string; level: string }>,
): ExtensionCommandContext {
  return {
    getSystemPrompt: getPrompt,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionCommandContext;
}

describe("Mikoto Dev extension", () => {
  it("registers the command, creates the agent directory, and overwrites the snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mikoto-dev-"));
    try {
      const agentDir = path.join(root, ".pi", "agent");
      const setupResult = setup(agentDir);
      assert.equal(setupResult.commandName, SYSTEM_PROMPT_DEBUG_COMMAND);

      let prompt = "# First prompt\n";
      const notifications: Array<{ message: string; level: string }> = [];
      const ctx = commandContext(() => prompt, notifications);
      const outputPath = path.join(agentDir, SYSTEM_PROMPT_DEBUG_FILE);

      await setupResult.command.handler("", ctx);
      assert.equal(await readFile(outputPath, "utf8"), prompt);

      prompt = "# Replacement prompt";
      await setupResult.command.handler("", ctx);
      assert.equal(await readFile(outputPath, "utf8"), prompt);
      assert.deepEqual(notifications.map((notice) => notice.level), ["info", "info"]);
      assert.ok(notifications.every((notice) => notice.message.includes(outputPath)));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a write failure without reporting success", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mikoto-dev-"));
    try {
      const agentDir = path.join(root, "not-a-directory");
      await writeFile(agentDir, "blocking file");
      const { command } = setup(agentDir);
      const notifications: Array<{ message: string; level: string }> = [];

      await command.handler(
        "",
        commandContext(() => "# Prompt", notifications),
      );

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.level, "error");
      assert.equal(await readFile(agentDir, "utf8"), "blocking file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
