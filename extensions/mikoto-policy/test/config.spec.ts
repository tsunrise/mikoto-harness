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
  type MikotoPolicyConfig,
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
