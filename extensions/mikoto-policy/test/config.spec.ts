import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  MikotoPolicyDocumentLoader,
  MikotoPolicyConfig,
  DEFAULT_SETTINGS,
  mergeSettings,
} from "../src/config.ts";
import { getCanonicalPath } from "../src/canonical-path.ts";

const bundledConfig: MikotoPolicyConfig = {
  filesystem: {
    denyRead: [],
    allowRead: [],
    allowWrite: ["."],
    denyWrite: [],
  },
};

async function withTempDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "mikoto-policy-config-"),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("MikotoPolicyDocumentLoader", () => {
  it("validates exact modes and complete atomic reviewer settings", () => {
    for (const escalation of ["ask-me", "auto-review", "always-deny"]) {
      assert.equal(MikotoPolicyConfig.parse({ escalation }).escalation, escalation);
    }
    for (const value of [
      { escalation: "automatic" }, { autoReview: { provider: "fake", model: "test" } },
      { autoReview: { agent: {} } }, { autoReview: { agent: null } },
      { autoReview: { agent: { thinkingLevel: "high" } } },
      { autoReview: { agent: { provider: " p ", model: "m", thinkingLevel: "low" } } },
      { autoReview: { agent: { provider: "p", model: "", thinkingLevel: "low" } } },
      { autoReview: { agent: { provider: "p", model: "m", thinkingLevel: "bogus" } } },
      { autoReview: { extra: "" } },
    ]) assert.equal(MikotoPolicyConfig.safeParse(value).success, false);
    const agent = { provider: "caller", model: "chosen", thinkingLevel: "max" } as const;
    const merged = mergeSettings([
      { escalation: "auto-review", autoReview: { policy: "global" } },
      { autoReview: { agent } }, { autoReview: {} },
    ]);
    assert.deepEqual(merged.autoReview, { agent, policy: "global" });
    assert.ok(Object.isFrozen(merged.autoReview.agent));
    assert.deepEqual(mergeSettings([{ autoReview: { policy: "old" } },
      { autoReview: { policy: "" } }]).autoReview, { ...DEFAULT_SETTINGS.autoReview, policy: "" });
  });

  it("pins layered settings, skips untrusted overrides and reloads without deep merging agents", async () => {
    await withTempDirectory(async (cwd) => {
      const globalPath = path.join(cwd, "global.json");
      const workspacePath = path.join(cwd, "mikoto-policy.json");
      const agent = { provider: "chosen-provider", model: "chosen-model", thinkingLevel: "high" };
      await writeFile(globalPath, JSON.stringify({ escalation: "auto-review", autoReview: { agent, policy: "global" } }));
      await writeFile(workspacePath, JSON.stringify({ autoReview: { policy: "" } }));
      const loader = new MikotoPolicyDocumentLoader({}, globalPath);
      assert.deepEqual((await loader.load(cwd, true)).settings.autoReview, { agent, policy: "" });
      assert.deepEqual((await loader.load(cwd, false)).settings.autoReview, { agent, policy: "global" });
      await writeFile(workspacePath, JSON.stringify({ escalation: "always-deny" }));
      assert.equal((await loader.load(cwd, true)).settings.escalation, "auto-review");
      assert.equal((await new MikotoPolicyDocumentLoader({}, globalPath).load(cwd, true)).settings.escalation, "always-deny");
      await writeFile(workspacePath, JSON.stringify({ autoReview: { agent: { thinkingLevel: "low" } } }));
      const invalid = await new MikotoPolicyDocumentLoader({}, globalPath).load(cwd, true);
      assert.ok(invalid.diagnostics.some((d) => d.kind === "invalid_layer"));
      assert.deepEqual(invalid.settings.autoReview, { agent, policy: "global" });
      assert.equal("escalation" in invalid.document, false);
      assert.equal("autoReview" in invalid.document, false);
    });
  });

  it("loads and merges bundled, global, and workspace policy", async () => {
    await withTempDirectory(async (directory) => {
      const cwd = path.join(directory, "workspace");
      const globalConfigPath = path.join(directory, "global.json");
      await writeFile(
        globalConfigPath,
        JSON.stringify({
          filesystem: {
            denyRead: ["global-secret"],
            allowWrite: { "+": ["global-output"] },
          },
        }),
      );
      await mkdir(cwd, { recursive: true });
      await writeFile(
        path.join(cwd, "mikoto-policy.json"),
        JSON.stringify({
          filesystem: {
            denyRead: { "+": ["workspace-secret"] },
            allowWrite: { "+": ["workspace-output"] },
          },
        }),
      );

      const loader = new MikotoPolicyDocumentLoader(
        bundledConfig,
        globalConfigPath,
      );
      const result = await loader.load(cwd, true);

      assert.deepEqual(result.warnings, []);
      assert.deepEqual(result.document.filesystem, {
        denyRead: [
          getCanonicalPath(path.join(cwd, "global-secret")),
          getCanonicalPath(path.join(cwd, "workspace-secret")),
        ],
        allowRead: [],
        allowWrite: [
          getCanonicalPath(cwd),
          getCanonicalPath(path.join(cwd, "global-output")),
          getCanonicalPath(path.join(cwd, "workspace-output")),
        ],
        denyWrite: [],
      });
      assert.ok(Object.isFrozen(result.document));
      assert.ok(Object.isFrozen(result.document.filesystem));
      assert.ok(Object.isFrozen(result.document.filesystem.allowWrite));

      const debug = await loader.debugLoad(cwd, true);
      assert.equal(debug.globalConfigPath, globalConfigPath);
      assert.equal(
        debug.workspaceConfigPath,
        path.join(cwd, "mikoto-policy.json"),
      );
      assert.strictEqual(debug.document, result.document);

      await writeFile(
        path.join(cwd, "mikoto-policy.json"),
        JSON.stringify({ filesystem: { allowWrite: ["/"] } }),
      );
      assert.strictEqual(await loader.load(cwd, true), result);
    });
  });

  it("caches parsed global policy while merging it for a new cwd", async () => {
    await withTempDirectory(async (directory) => {
      const firstCwd = path.join(directory, "first");
      const secondCwd = path.join(directory, "second");
      const globalConfigPath = path.join(directory, "global.json");
      await writeFile(
        globalConfigPath,
        JSON.stringify({
          filesystem: {
            allowWrite: ["global-output"],
          },
        }),
      );
      const loader = new MikotoPolicyDocumentLoader(
        bundledConfig,
        globalConfigPath,
      );

      const first = await loader.load(firstCwd, true);
      await writeFile(
        globalConfigPath,
        JSON.stringify({
          filesystem: {
            allowWrite: ["/"],
          },
        }),
      );
      const second = await loader.load(secondCwd, true);

      assert.deepEqual(first.document.filesystem.allowWrite, [
        getCanonicalPath(path.join(firstCwd, "global-output")),
      ]);
      assert.deepEqual(second.document.filesystem.allowWrite, [
        getCanonicalPath(path.join(secondCwd, "global-output")),
      ]);
    });
  });

  it("pins canonical policy paths for the loader lifetime", async () => {
    await withTempDirectory(async (cwd) => {
      const firstTarget = path.join(cwd, "first");
      const secondTarget = path.join(cwd, "second");
      const alias = path.join(cwd, "alias");
      await mkdir(firstTarget);
      await mkdir(secondTarget);
      await symlink(firstTarget, alias);
      const loader = new MikotoPolicyDocumentLoader(
        { filesystem: { denyRead: [alias] } },
        path.join(cwd, "missing-global.json"),
      );

      const first = await loader.load(cwd, true);
      await rm(alias);
      await symlink(secondTarget, alias);
      const second = await loader.load(cwd, true);

      assert.strictEqual(second, first);
      assert.deepEqual(first.document.filesystem.denyRead, [
        getCanonicalPath(firstTarget),
      ]);
    });
  });

  it("silently ignores missing user policy files", async () => {
    await withTempDirectory(async (cwd) => {
      const result = await new MikotoPolicyDocumentLoader(
        bundledConfig,
        path.join(cwd, "missing-global.json"),
      ).load(cwd, true);

      assert.deepEqual(result.warnings, []);
      assert.deepEqual(result.document.filesystem.allowWrite, [
        getCanonicalPath(cwd),
      ]);
    });
  });

  it("skips an existing workspace policy until the cwd is trusted", async () => {
    await withTempDirectory(async (cwd) => {
      const workspaceConfigPath = path.join(cwd, "mikoto-policy.json");
      await writeFile(
        workspaceConfigPath,
        JSON.stringify({
          filesystem: {
            allowWrite: ["/"],
          },
        }),
      );
      const loader = new MikotoPolicyDocumentLoader(
        bundledConfig,
        path.join(cwd, "missing-global.json"),
      );

      const untrusted = await loader.load(cwd, false);
      assert.deepEqual(untrusted.document.filesystem.allowWrite, [
        getCanonicalPath(cwd),
      ]);
      assert.deepEqual(untrusted.warnings, [
        `Mikoto Policy skipped ${workspaceConfigPath} because the workspace is not trusted.`,
      ]);

      const trusted = await loader.load(cwd, true);
      assert.deepEqual(trusted.document.filesystem.allowWrite, ["/"]);
      assert.deepEqual(trusted.warnings, []);
    });
  });

  it("uses bundled policy and skips workspace policy when global policy is invalid", async () => {
    await withTempDirectory(async (cwd) => {
      const globalConfigPath = path.join(cwd, "global.json");
      await writeFile(globalConfigPath, "{");
      await writeFile(
        path.join(cwd, "mikoto-policy.json"),
        JSON.stringify({
          filesystem: {
            allowWrite: ["/"],
          },
        }),
      );

      const result = await new MikotoPolicyDocumentLoader(
        bundledConfig,
        globalConfigPath,
      ).load(cwd, true);

      assert.deepEqual(result.document.filesystem.allowWrite, [
        getCanonicalPath(cwd),
      ]);
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0], /ignored invalid policy/);
      assert.match(result.warnings[0], /global\.json/);
    });
  });

  it("keeps valid global policy when workspace policy is invalid", async () => {
    await withTempDirectory(async (cwd) => {
      const globalConfigPath = path.join(cwd, "global.json");
      const workspaceConfigPath = path.join(cwd, "mikoto-policy.json");
      await writeFile(
        globalConfigPath,
        JSON.stringify({
          filesystem: {
            allowWrite: ["global-output"],
          },
        }),
      );
      await writeFile(
        workspaceConfigPath,
        JSON.stringify({
          filesystem: {
            allowWrite: ["*"],
          },
        }),
      );

      const result = await new MikotoPolicyDocumentLoader(
        bundledConfig,
        globalConfigPath,
      ).load(cwd, true);

      assert.deepEqual(result.document.filesystem.allowWrite, [
        getCanonicalPath(path.join(cwd, "global-output")),
      ]);
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0], /ignored invalid policy/);
      assert.match(result.warnings[0], /mikoto-policy\.json/);
    });
  });
});
