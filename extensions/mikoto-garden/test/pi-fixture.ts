// Explicitly loaded only for real Pi smoke tests; no production integration.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import garden from "../src/index.ts";
import type { Delivery } from "../src/protocol.ts";

export default function fixture(pi: ExtensionAPI): void {
  const tools = new Map<string, ToolDefinition>();
  let pickerId: number | undefined;
  garden({
    ...pi,
    registerCommand(name, command) {
      pi.registerCommand(name, {
        ...command,
        async handler(args, ctx) {
          await command.handler(args, {
            ...ctx,
            ui: {
              ...ctx.ui,
              async custom(factory, options) {
                // The PTY driver waits on fixture markers, not production
                // titles/borders/help text. Never copy rendered debug frames.
                process.stderr.write("\nGARDEN_VIEW_OPEN\n");
                const result = await ctx.ui.custom(factory, options);
                process.stderr.write("\nGARDEN_VIEW_CLOSED\n");
                return result;
              },
            },
          });
        },
      });
    },
    registerTool(definition) {
      tools.set(definition.name, definition as unknown as ToolDefinition);
      pi.registerTool(definition);
    },
  });
  pi.registerCommand("garden-smoke", {
    description: "Garden integration fixture (no model request)",
    async handler(_args, ctx) {
      assert.ok(!pi.getActiveTools().includes("bash"));
      const exec = tools.get("exec_command")!;
      const input = tools.get("write_stdin")!;
      const first = await exec.execute("smoke-start", {
        cmd: "printf 'line1\\n\"quote\"\\\\backslash'; /bin/cat", stdin: true, login: false, yield_time_ms: 0,
      }, undefined, undefined, ctx);
      const text = first.content[0];
      assert.equal(text.type, "text");
      assert.match(text.type === "text" ? text.text : "", /Sandbox mode: sandboxed/);
      assert.equal((first.details as Delivery).yielded, true);
      const id = (first.details as { job: { id: number } }).job.id;
      const done = await input.execute("smoke-eof", { session_id: id, close_stdin: true }, undefined, undefined, ctx);
      assert.match(done.content[0].type === "text" ? done.content[0].text : "", /Process exited with code 0/);
      const skill = await readFile(
        new URL("../../mikoto-terminal-notify/skills/terminal-notify/SKILL.md", import.meta.url),
        "utf8",
      );
      const helper = skill.match(/```sh\n([\s\S]*?)\n```/)?.[1];
      assert.ok(helper);
      const notification = await exec.execute("smoke-capability", {
        cmd: `${helper}\nnotify_progress GARDEN_CAPABILITY_OK`,
        login: false,
      }, undefined, undefined, ctx);
      assert.match(notification.content[0].type === "text" ? notification.content[0].text : "", /Process exited with code 0/);
      ctx.ui.notify(`GARDEN_SMOKE_OK active=${pi.getActiveTools().join(",")}`, "info");
    },
  });
  pi.registerCommand("garden-escalation-smoke", {
    description: "Request exactly one harmless host true command through the real Policy broker",
    async handler(_args, ctx) {
      try {
        ctx.ui.notify("GARDEN_ESCALATION_REQUESTED", "info");
        const result = await tools.get("exec_command")!.execute("smoke-escalation", {
          cmd: "true", login: false, sandbox_permissions: "require_escalated",
          justification: "Verify the Garden integration with the existing Policy broker using a no-op command.",
        }, undefined, undefined, ctx);
        const details = result.details as Delivery;
        assert.equal(details.job.mode, "unsandboxed");
        assert.equal(details.job.exit_code, 0);
        ctx.ui.notify("GARDEN_ESCALATION_APPROVED", "info");
      } catch (error) { ctx.ui.notify(`GARDEN_ESCALATION_REJECTED: ${(error as Error).message}`, "info"); }
    },
  });
  pi.registerCommand("garden-picker-smoke", {
    description: "Start one bounded pipe reader for the real /ps stop control",
    async handler(args, ctx) {
      if (args === "check") {
        assert.ok(pickerId);
        const result = await tools.get("write_stdin")!.execute("smoke-picker-check", {
          session_id: pickerId, yield_time_ms: 250,
        }, undefined, undefined, ctx);
        const details = result.details as Delivery;
        assert.equal(details.yielded, false, "The picker must actually stop the reader");
        assert.equal(details.job.id, pickerId);
        ctx.ui.notify("GARDEN_PICKER_STOPPED", "info");
        return;
      }
      const result = await tools.get("exec_command")!.execute("smoke-picker", {
        cmd: "printf PICKER_PREVIEW; /bin/cat", stdin: true, login: false, yield_time_ms: 250,
      }, undefined, undefined, ctx);
      pickerId = (result.details as Delivery).job.id;
      ctx.ui.notify("GARDEN_PICKER_READY", "info");
    },
  });
}
