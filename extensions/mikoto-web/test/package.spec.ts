import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("packed package loads its deferred tool through Pi without install scripts", { timeout: 30000 }, async () => {
  const run = promisify(execFile);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "web-package-test-"));
  try {
    const packed = await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: root });
    // npm 12 keys pack results by package name; older versions used an array.
    const [{ filename }] = Object.values(JSON.parse(packed.stdout)) as { filename: string }[];
    await run("tar", ["-xzf", join(directory, filename), "-C", directory]);
    // This stands in for installed runtime dependencies; no install scripts
    // or real credentials are used.
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
    assert.equal(web.tools.size, 1);
    const tool = web.tools.get("web_run")!.definition;
    assert.equal(tool.exposure, "deferred");
    assert.equal(tool.namespace?.name, "web");
    assert.ok(tool.outputSchema);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
