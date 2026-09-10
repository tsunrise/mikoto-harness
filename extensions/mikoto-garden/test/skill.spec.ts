import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const creatorSkill = new URL("../skills/capability-creator/SKILL.md", import.meta.url);

test("packed Garden package discovers its capability-creator skill without install scripts", { timeout: 45000 }, async () => {
  const authoredCreator = await readFile(creatorSkill, "utf8");
  const parent = join(root, "test-runtime");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "skill-package-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const packed = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir], { cwd: root });
    const [metadata] = JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[];
    assert.ok(metadata!.files.some((file) => file.path === "skills/capability-creator/SKILL.md"));
    assert.ok(!metadata!.files.some((file) => file.path.startsWith("dist/skills/")));
    await run("tar", ["-xzf", join(dir, metadata!.filename), "-C", dir]);
    assert.equal(
      await readFile(join(dir, "package/skills/capability-creator/SKILL.md"), "utf8"),
      authoredCreator,
    );
    const manifest = JSON.parse(await readFile(join(dir, "package/package.json"), "utf8"));
    assert.deepEqual(manifest.pi.skills, ["./skills"]);
    // Load only the packed package's skill resources. There are no installed
    // runtime dependencies here and no model request or active-user setting edit.
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      packages: [{ source: join(dir, "package"), extensions: [] }],
    }));
    const cli = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(/index\.(js|ts)$/, "cli.js");
    child = spawn(process.execPath, [
      cli, "--mode", "rpc", "--no-session", "--no-tools", "--no-extensions",
      "--no-context-files", "--no-prompt-templates", "--no-themes", "--offline", "--no-approve",
    ], { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] });
    const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("Packed skill discovery timed out")), 15000);
      child!.on("error", (error) => { clearTimeout(timer); reject(error); });
      child!.once("exit", () => { clearTimeout(timer); reject(new Error("Pi exited before skill discovery")); });
      child!.stderr!.resume();
      child!.stdout!.on("data", (chunk) => {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const boundary = buffer.indexOf("\n");
          const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
          let message: Record<string, unknown>;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.type === "response" && message.id === "commands") {
            clearTimeout(timer); resolve(message);
          }
        }
      });
    });
    child.stdin!.write(JSON.stringify({ id: "commands", type: "get_commands" }) + "\n");
    const response = await ready;
    const commands = (
      response.data as {
        commands: { name: string; source: string }[];
      }
    ).commands;
    assert.equal(
      commands.filter(
        (command) => command.name === "skill:capability-creator" && command.source === "skill",
      ).length,
      1,
    );
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child!.once("close", () => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  }
});
