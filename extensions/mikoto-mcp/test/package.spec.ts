import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { directory } from "./helpers.ts";

test("Pi loads the wrapper and discovers the bundled execution skill without starting a session", async t => {
  const root = await directory(t);
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root,
    settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
    noContextFiles: true, noPromptTemplates: true, noThemes: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const extension = loader.getExtensions().extensions.find(e => e.path.startsWith(packageRoot));
  assert.ok(extension);
  assert.deepEqual([...extension.tools.keys()], ["mcp_tool_search"]);
  assert.deepEqual([...extension.commands.keys()], ["mcp", "mcp:verbose"]);
  const skills = loader.getSkills().skills.filter(s => s.filePath.startsWith(packageRoot));
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "mcp");
});
