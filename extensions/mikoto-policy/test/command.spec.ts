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
import { MikotoPolicyDocumentLoader } from "../src/config.ts";

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

      let editorTitle: string | undefined;
      let editorText: string | undefined;
      const ctx = {
        cwd,
        hasUI: true,
        isProjectTrusted: () => true,
        ui: {
          async editor(title: string, text: string) {
            editorTitle = title;
            editorText = text;
            return undefined;
          },
        },
      } as unknown as ExtensionCommandContext;
      await command.handler("", ctx);

      assert.equal(editorTitle, "Mikoto Policy");
      assert.match(editorText ?? "", new RegExp(globalConfigPath));
      assert.match(editorText ?? "", new RegExp(workspaceConfigPath));
      assert.match(
        editorText ?? "",
        new RegExp(path.join(cwd, "global-secret")),
      );
      assert.match(
        editorText ?? "",
        new RegExp(path.join(cwd, "readonly")),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
