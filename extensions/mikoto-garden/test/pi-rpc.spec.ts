import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("real Pi RPC: tools, notifications, --no-tools and unchanged direct bash", { skip: process.platform !== "darwin", timeout: 45000 }, async () => {
  const parent = fileURLToPath(new URL("../test-runtime/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "pi-"));
  const cli = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(/index\.(js|ts)$/, "cli.js");
  const child = spawn(process.execPath, [
    cli, "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
    "--no-context-files", "--no-prompt-templates", "--no-themes", "--offline", "--no-approve",
    "-e", fileURLToPath(new URL("../../mikoto-policy/index.ts", import.meta.url)),
    "-e", fileURLToPath(new URL("./pi-fixture.ts", import.meta.url)),
    "-e", fileURLToPath(new URL("../../mikoto-terminal-notify", import.meta.url)),
  ], { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir, TMPDIR: dir }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const messages: Record<string, unknown>[] = [];
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    while (stdout.includes("\n")) {
      const boundary = stdout.indexOf("\n");
      const line = stdout.slice(0, boundary); stdout = stdout.slice(boundary + 1);
      try { messages.push(JSON.parse(line)); } catch { /* Report malformed startup output on failure. */ }
    }
  });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  const wait = async (predicate: (value: Record<string, unknown>) => boolean) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`Pi exited: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Pi RPC timeout: ${stderr}\n${JSON.stringify(messages).slice(-4096)}`);
  };
  try {
    child.stdin.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n");
    const commands = await wait((m) => m.id === "commands" && m.type === "response");
    assert.match(JSON.stringify(commands), /ps:debug/);
    child.stdin.write(JSON.stringify({ id: "smoke", type: "prompt", message: "/garden-smoke" }) + "\n");
    const notification = await wait((m) => m.method === "notify" && String(m.message).startsWith("GARDEN_SMOKE_OK"));
    assert.equal(notification.message, "GARDEN_SMOKE_OK active=");
    assert.ok(messages.some((m) => m.message === "GARDEN_CAPABILITY_OK"));
    child.stdin.write(JSON.stringify({ id: "ps", type: "prompt", message: "/ps" }) + "\n");
    const status = await wait((m) => m.method === "notify" && String(m.message).startsWith("Mikoto Garden:"));
    assert.match(String(status.message), /ready; capabilities available/);
    assert.match(String(status.message), /No managed processes\./);
    // A command may legitimately contain ${GARDEN_TOKEN:-}; that is shell
    // source, not the credential-bearing diagnostic field.
    assert.doesNotMatch(String(status.message), /GARDEN_TOKEN:\s/);
    child.stdin.write(JSON.stringify({ id: "debug", type: "prompt", message: "/ps:debug" }) + "\n");
    await wait((m) => m.method === "notify" && m.message === "Garden /ps:debug requires the interactive TUI.");
    child.stdin.write(JSON.stringify({ id: "escalation", type: "prompt", message: "/garden-escalation-smoke" }) + "\n");
    const rejection = await wait((m) => m.method === "notify" && String(m.message).startsWith("GARDEN_ESCALATION_REJECTED"));
    assert.match(String(rejection.message), /non_interactive/);
    child.stdin.write(JSON.stringify({ id: "user-bash", type: "bash", command: "printf USER_BASH_UNCHANGED" }) + "\n");
    const bash = await wait((m) => m.id === "user-bash" && m.type === "response");
    assert.equal((bash.data as { output: string }).output, "USER_BASH_UNCHANGED");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once("close", () => resolve()); });
    await rm(dir, { recursive: true, force: true });
  }
});
