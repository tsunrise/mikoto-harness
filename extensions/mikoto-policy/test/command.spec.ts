import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { registerViewConfigCommand } from "../src/command.ts";
import {
  MikotoPolicyDocumentLoader,
  PERMISSION_PATH,
} from "../src/config.ts";

describe("registerViewConfigCommand", () => {
  it("registers a manual command that displays paths and merged policy", async () => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "mikoto-policy-command-"),
    );
    try {
      const globalConfigPath = path.join(cwd, "global.json");
      const workspaceConfigPath = path.join(cwd, "mikoto-policy.json");
      await writeFile(
        globalConfigPath,
        JSON.stringify({
          filesystem: {
            denyRead: ["global-secret"],
          },
        }),
      );
      await writeFile(
        workspaceConfigPath,
        JSON.stringify({
          filesystem: {
            denyWrite: ["readonly"],
          },
        }),
      );
      const loader = new MikotoPolicyDocumentLoader(
        {
          filesystem: {
            allowWrite: ["."],
          },
        },
        globalConfigPath,
      );
      let commandName: string | undefined;
      let command:
        | {
            description: string;
            handler(
              args: string,
              ctx: ExtensionCommandContext,
            ): Promise<void>;
          }
        | undefined;
      const pi = {
        registerCommand(name: string, registeredCommand: typeof command) {
          commandName = name;
          command = registeredCommand;
        },
        registerTool() {
          assert.fail("The config viewer must not register an LLM tool.");
        },
      } as unknown as ExtensionAPI;

      registerViewConfigCommand(loader, pi);
      assert.equal(commandName, "mikoto-policy:view");
      assert.equal(
        command?.description,
        "View the effective Mikoto policy configuration",
      );
      assert.ok(command);

      let notificationText: string | undefined;
      let notificationLevel: string | undefined;
      const ctx = {
        cwd,
        hasUI: true,
        isProjectTrusted: () => true,
        ui: {
          notify(text: string, level: string) {
            notificationText = text;
            notificationLevel = level;
          },
        },
      } as unknown as ExtensionCommandContext;
      await command.handler("", ctx);

      assert.equal(notificationLevel, "info");
      assert.ok(notificationText?.includes(globalConfigPath));
      assert.ok(notificationText?.includes(workspaceConfigPath));
      assert.ok(notificationText?.includes(PERMISSION_PATH));
      assert.ok(
        notificationText?.includes(path.join(cwd, "global-secret")),
      );
      assert.ok(
        notificationText?.includes(path.join(cwd, "readonly")),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
