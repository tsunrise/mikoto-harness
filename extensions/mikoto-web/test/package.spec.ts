import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

test("packed package loads its extension and skill through Pi and executes its helper", { timeout: 30000 }, async () => {
  const run = promisify(execFile);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "web-package-test-"));
  try {
    const packed = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: root });
    // npm 12 keys pack results by package name; older versions used an array.
    const [{ filename }] = Object.values(JSON.parse(packed.stdout)) as { filename: string }[];
    await run("tar", ["-xzf", join(directory, filename), "-C", directory]);
    // This stands in for installed runtime dependencies. The extension imports
    // only zod at runtime, and no install scripts or real credentials are used.
    await symlink(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(directory, "node_modules"));
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: join(directory, "profile"),
      settingsManager: SettingsManager.inMemory({ packages: [join(directory, "package")] }),
      noContextFiles: true, noPromptTemplates: true, noThemes: true,
    });
    await loader.reload();
    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, []);
    const web = extensions.extensions.find((extension) => extension.path.includes(join(directory, "package")));
    assert.ok(web);
    assert.equal(web.tools.size, 0);
    const context = {
      modelRegistry: {
        getProviderAuthStatus: () => ({ configured: false }),
        getProviderAuth: async () => { assert.fail("No credentials should be resolved"); },
      },
      sessionManager: { getSessionId: () => "packed-test-session" },
      hasUI: false,
    } as unknown as ExtensionContext;
    for (const handler of web.handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, context);
    }
    const skills = loader.getSkills().skills.filter((skill) =>
      skill.name === "web" && skill.filePath.startsWith(directory));
    assert.equal(skills.length, 1);
    // An actual invocation of the packed helper checks its runtime portability.
    // Missing Garden is intentional: it must fail cleanly without contacting
    // a provider or loading credentials.
    await assert.rejects(run(process.execPath, [join(directory, "package/skills/web/scripts/web.mjs"), "{}"], {
      env: { ...process.env, GARDEN_SERVER: "", GARDEN_TOKEN: "" },
    }), (error: any) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.ok(error.stderr.length > 0);
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
