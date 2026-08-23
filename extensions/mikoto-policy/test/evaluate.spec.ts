import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { MikotoPolicyDocument } from "mikoto-types";
import {
  evaluateRead,
  evaluateWrite,
} from "../src/evaluate.ts";

const VIRTUAL_ROOT = "/mikoto-policy-evaluate-tests";

function virtualPath(...segments: string[]): string {
  return path.join(VIRTUAL_ROOT, ...segments);
}

function createPolicy(
  filesystem: Partial<MikotoPolicyDocument["filesystem"]> = {},
): MikotoPolicyDocument {
  return {
    filesystem: {
      denyRead: [],
      allowRead: [],
      allowWrite: [],
      denyWrite: [],
      ...filesystem,
    },
  };
}

async function withTempDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "mikoto-policy-evaluate-"),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("evaluateRead file", () => {
  it("allows reads by default", () => {
    const requestedPath = virtualPath("project", "file.txt");
    assert.deepEqual(
      evaluateRead(createPolicy(), requestedPath, "file"),
      { allowed: true },
    );
  });

  it("denies an exact path", () => {
    const deniedPath = virtualPath("project", ".env");
    assert.deepEqual(
      evaluateRead(
        createPolicy({ denyRead: [deniedPath] }),
        deniedPath,
        "file",
      ),
      { allowed: false, deniedPath },
    );
  });

  it("denies descendants of a denied directory", () => {
    const deniedPath = virtualPath("project", "secrets");
    assert.deepEqual(
      evaluateRead(
        createPolicy({ denyRead: [deniedPath] }),
        path.join(deniedPath, "token.txt"),
        "file",
      ),
      { allowed: false, deniedPath },
    );
  });

  it("does not match path-prefix siblings", () => {
    const deniedPath = virtualPath("project", "src");
    assert.deepEqual(
      evaluateRead(
        createPolicy({ denyRead: [deniedPath] }),
        virtualPath("project", "src-other", "file.ts"),
        "file",
      ),
      { allowed: true },
    );
  });

  it("allows a narrower carve-out inside a broad deny", () => {
    const deniedPath = virtualPath("users");
    const allowedPath = path.join(deniedPath, "project");
    assert.deepEqual(
      evaluateRead(
        createPolicy({
          denyRead: [deniedPath],
          allowRead: [allowedPath],
        }),
        path.join(allowedPath, "src", "file.ts"),
        "file",
      ),
      { allowed: true },
    );
  });

  it("keeps a more specific deny inside a broad allow", () => {
    const allowedPath = virtualPath("project");
    const deniedPath = path.join(allowedPath, ".env");
    assert.deepEqual(
      evaluateRead(
        createPolicy({
          denyRead: [deniedPath],
          allowRead: [allowedPath],
        }),
        deniedPath,
        "file",
      ),
      { allowed: false, deniedPath },
    );
  });

  it("lets an equal allow override a deny", () => {
    const rulePath = virtualPath("project", "generated");
    assert.deepEqual(
      evaluateRead(
        createPolicy({
          denyRead: [rulePath],
          allowRead: [rulePath],
        }),
        path.join(rulePath, "file.txt"),
        "file",
      ),
      { allowed: true },
    );
  });

  it("uses the deepest matching deny regardless of rule order", () => {
    const broadDeny = virtualPath("project");
    const specificDeny = path.join(broadDeny, "secrets");
    const allowedPath = path.join(broadDeny, "public");
    const requestedPath = path.join(specificDeny, "token.txt");

    for (const denyRead of [
      [broadDeny, specificDeny],
      [specificDeny, broadDeny],
    ]) {
      assert.deepEqual(
        evaluateRead(
          createPolicy({ denyRead, allowRead: [allowedPath] }),
          requestedPath,
          "file",
        ),
        { allowed: false, deniedPath: specificDeny },
      );
    }
  });

  it("does not apply an unrelated allow", () => {
    const deniedPath = virtualPath("project", "secrets");
    assert.deepEqual(
      evaluateRead(
        createPolicy({
          denyRead: [deniedPath],
          allowRead: [virtualPath("project", "public")],
        }),
        path.join(deniedPath, "token.txt"),
        "file",
      ),
      { allowed: false, deniedPath },
    );
  });
});

describe("evaluateRead directory", () => {
  it("denies a directory inside a broad deny", () => {
    const deniedPath = virtualPath("users");
    assert.deepEqual(
      evaluateRead(
        createPolicy({ denyRead: [deniedPath] }),
        path.join(deniedPath, "project"),
        "directory",
      ),
      { allowed: false, deniedPath },
    );
  });

  it("denies a parent directory containing a denied subtree", () => {
    const requestedPath = virtualPath("project");
    const deniedPath = path.join(requestedPath, "secrets");
    assert.deepEqual(
      evaluateRead(
        createPolicy({ denyRead: [deniedPath] }),
        requestedPath,
        "directory",
      ),
      { allowed: false, deniedPath },
    );
  });

  it("allows a parent when an equal allow neutralizes its denied subtree", () => {
    const requestedPath = virtualPath("project");
    const rulePath = path.join(requestedPath, "generated");
    assert.deepEqual(
      evaluateRead(
        createPolicy({
          denyRead: [rulePath],
          allowRead: [rulePath],
        }),
        requestedPath,
        "directory",
      ),
      { allowed: true },
    );
  });

  it("denies a parent when an allow covers only part of a denied subtree", () => {
    const requestedPath = virtualPath("project");
    const deniedPath = path.join(requestedPath, "secrets");
    const allowedPath = path.join(deniedPath, "public");
    assert.deepEqual(
      evaluateRead(
        createPolicy({
          denyRead: [deniedPath],
          allowRead: [allowedPath],
        }),
        requestedPath,
        "directory",
      ),
      { allowed: false, deniedPath },
    );
  });

  it("allows a requested subtree carved out of a broad deny", () => {
    const deniedPath = virtualPath("users");
    const requestedPath = path.join(deniedPath, "project");
    assert.deepEqual(
      evaluateRead(
        createPolicy({
          denyRead: [deniedPath],
          allowRead: [requestedPath],
        }),
        requestedPath,
        "directory",
      ),
      { allowed: true },
    );
  });

  it("detects a more specific deny below an allowed requested subtree", () => {
    const broadDeny = virtualPath("users");
    const requestedPath = path.join(broadDeny, "project");
    const specificDeny = path.join(requestedPath, "secrets");
    assert.deepEqual(
      evaluateRead(
        createPolicy({
          denyRead: [broadDeny, specificDeny],
          allowRead: [requestedPath],
        }),
        requestedPath,
        "directory",
      ),
      { allowed: false, deniedPath: specificDeny },
    );
  });

  it("ignores denied subtrees outside the requested directory", () => {
    const requestedPath = virtualPath("project", "src");
    assert.deepEqual(
      evaluateRead(
        createPolicy({
          denyRead: [virtualPath("project", "secrets")],
        }),
        requestedPath,
        "directory",
      ),
      { allowed: true },
    );
  });

  it("denies when any of several denied subtrees remains effective", () => {
    const requestedPath = virtualPath("project");
    const generatedPath = path.join(requestedPath, "generated");
    const secretsPath = path.join(requestedPath, "secrets");
    assert.deepEqual(
      evaluateRead(
        createPolicy({
          denyRead: [generatedPath, secretsPath],
          allowRead: [generatedPath],
        }),
        requestedPath,
        "directory",
      ),
      { allowed: false, deniedPath: secretsPath },
    );
  });
});

describe("evaluateWrite", () => {
  it("denies writes by default", () => {
    const requestedPath = virtualPath("project", "file.txt");
    assert.deepEqual(
      evaluateWrite(createPolicy(), requestedPath),
      { allowed: false, deniedPath: requestedPath },
    );
  });

  it("allows an exact allowed path", () => {
    const allowedPath = virtualPath("project", "file.txt");
    assert.deepEqual(
      evaluateWrite(
        createPolicy({ allowWrite: [allowedPath] }),
        allowedPath,
      ),
      { allowed: true },
    );
  });

  it("allows descendants of an allowed directory", () => {
    const allowedPath = virtualPath("project");
    assert.deepEqual(
      evaluateWrite(
        createPolicy({ allowWrite: [allowedPath] }),
        path.join(allowedPath, "src", "file.ts"),
      ),
      { allowed: true },
    );
  });

  it("does not match path-prefix siblings", () => {
    const allowedPath = virtualPath("project", "src");
    const requestedPath = virtualPath("project", "src-other", "file.ts");
    assert.deepEqual(
      evaluateWrite(
        createPolicy({ allowWrite: [allowedPath] }),
        requestedPath,
      ),
      { allowed: false, deniedPath: requestedPath },
    );
  });

  it("lets an exact deny override an allow", () => {
    const allowedPath = virtualPath("project");
    const deniedPath = path.join(allowedPath, ".env");
    assert.deepEqual(
      evaluateWrite(
        createPolicy({
          allowWrite: [allowedPath],
          denyWrite: [deniedPath],
        }),
        deniedPath,
      ),
      { allowed: false, deniedPath },
    );
  });

  it("denies descendants of a denied directory", () => {
    const allowedPath = virtualPath("project");
    const deniedPath = path.join(allowedPath, "generated");
    assert.deepEqual(
      evaluateWrite(
        createPolicy({
          allowWrite: [allowedPath],
          denyWrite: [deniedPath],
        }),
        path.join(deniedPath, "file.txt"),
      ),
      { allowed: false, deniedPath },
    );
  });

  it("lets a broad deny override a more specific allow", () => {
    const deniedPath = virtualPath("project");
    const allowedPath = path.join(deniedPath, "generated");
    assert.deepEqual(
      evaluateWrite(
        createPolicy({
          allowWrite: [allowedPath],
          denyWrite: [deniedPath],
        }),
        path.join(allowedPath, "file.txt"),
      ),
      { allowed: false, deniedPath },
    );
  });

  it("ignores unrelated deny rules", () => {
    const allowedPath = virtualPath("project");
    assert.deepEqual(
      evaluateWrite(
        createPolicy({
          allowWrite: [allowedPath],
          denyWrite: [virtualPath("other")],
        }),
        path.join(allowedPath, "file.txt"),
      ),
      { allowed: true },
    );
  });

  it("evaluates missing files and parent directories", () => {
    const allowedPath = virtualPath("project");
    assert.deepEqual(
      evaluateWrite(
        createPolicy({ allowWrite: [allowedPath] }),
        path.join(allowedPath, "new", "nested", "file.txt"),
      ),
      { allowed: true },
    );
  });
});

describe("symlink evaluation", () => {
  it("denies a write that escapes an allowed root through a child symlink", async () => {
    await withTempDirectory(async (directory) => {
      const allowedPath = path.join(directory, "allowed");
      const outsidePath = path.join(directory, "outside");
      await mkdir(allowedPath);
      await mkdir(outsidePath);
      await symlink(outsidePath, path.join(allowedPath, "escape"));

      const requestedPath = path.join(allowedPath, "escape", "file.txt");
      assert.deepEqual(
        evaluateWrite(
          createPolicy({ allowWrite: [allowedPath] }),
          requestedPath,
        ),
        { allowed: false, deniedPath: requestedPath },
      );
    });
  });

  it("allows an external alias that resolves into an allowed root", async () => {
    await withTempDirectory(async (directory) => {
      const allowedPath = path.join(directory, "allowed");
      const aliasPath = path.join(directory, "alias");
      await mkdir(allowedPath);
      await symlink(allowedPath, aliasPath);

      assert.deepEqual(
        evaluateWrite(
          createPolicy({ allowWrite: [allowedPath] }),
          path.join(aliasPath, "file.txt"),
        ),
        { allowed: true },
      );
    });
  });

  it("rejects an allowed root replaced by an outside symlink", async () => {
    await withTempDirectory(async (directory) => {
      const allowedPath = path.join(directory, "allowed");
      const outsidePath = path.join(directory, "outside");
      await mkdir(allowedPath);
      await mkdir(outsidePath);
      const policy = createPolicy({ allowWrite: [allowedPath] });

      await rm(allowedPath, { recursive: true });
      await symlink(outsidePath, allowedPath);

      const requestedPath = path.join(allowedPath, "file.txt");
      assert.deepEqual(
        evaluateWrite(policy, requestedPath),
        { allowed: false, deniedPath: requestedPath },
      );
    });
  });

  it("applies a deny symlink to direct and aliased target access", async () => {
    await withTempDirectory(async (directory) => {
      const allowedPath = path.join(directory, "allowed");
      const deniedTarget = path.join(allowedPath, "target");
      const deniedAlias = path.join(allowedPath, "alias");
      await mkdir(deniedTarget, { recursive: true });
      await symlink(deniedTarget, deniedAlias);
      const policy = createPolicy({
        allowWrite: [allowedPath],
        denyWrite: [deniedAlias],
      });

      for (const requestedPath of [
        path.join(deniedTarget, "file.txt"),
        path.join(deniedAlias, "file.txt"),
      ]) {
        assert.deepEqual(
          evaluateWrite(policy, requestedPath),
          { allowed: false, deniedPath: deniedAlias },
        );
      }
    });
  });

  it("resolves a dangling deny symlink to its write target", async () => {
    await withTempDirectory(async (directory) => {
      const deniedTarget = path.join(directory, "missing-target.txt");
      const deniedAlias = path.join(directory, "alias.txt");
      await symlink(deniedTarget, deniedAlias);

      assert.deepEqual(
        evaluateWrite(
          createPolicy({
            allowWrite: [directory],
            denyWrite: [deniedAlias],
          }),
          deniedTarget,
        ),
        { allowed: false, deniedPath: deniedAlias },
      );
    });
  });

  it("resolves a missing write below a symlinked ancestor", async () => {
    await withTempDirectory(async (directory) => {
      const allowedTarget = path.join(directory, "target");
      const allowedAlias = path.join(directory, "alias");
      await mkdir(allowedTarget);
      await symlink(allowedTarget, allowedAlias);

      assert.deepEqual(
        evaluateWrite(
          createPolicy({ allowWrite: [directory] }),
          path.join(allowedAlias, "new", "file.txt"),
        ),
        { allowed: true },
      );
    });
  });

  it("matches read denies through both direct and aliased paths", async () => {
    await withTempDirectory(async (directory) => {
      const deniedTarget = path.join(directory, "target");
      const deniedAlias = path.join(directory, "alias");
      await mkdir(deniedTarget);
      await symlink(deniedTarget, deniedAlias);
      const policy = createPolicy({ denyRead: [deniedAlias] });

      for (const requestedPath of [
        path.join(deniedTarget, "file.txt"),
        path.join(deniedAlias, "file.txt"),
      ]) {
        assert.deepEqual(
          evaluateRead(policy, requestedPath, "file"),
          { allowed: false, deniedPath: deniedAlias },
        );
      }
    });
  });

  it("ignores an allow symlink redirected outside its lexical tree", async () => {
    await withTempDirectory(async (directory) => {
      const deniedTarget = path.join(directory, "denied");
      const allowedAlias = path.join(directory, "allowed-alias");
      await mkdir(deniedTarget);
      await symlink(deniedTarget, allowedAlias);

      assert.deepEqual(
        evaluateRead(
          createPolicy({
            denyRead: [deniedTarget],
            allowRead: [allowedAlias],
          }),
          path.join(deniedTarget, "file.txt"),
          "file",
        ),
        { allowed: false, deniedPath: deniedTarget },
      );
    });
  });

  it("accepts the /tmp canonical alias for allow rules", async () => {
    const directory = await mkdtemp("/tmp/mikoto-policy-evaluate-");
    try {
      assert.deepEqual(
        evaluateWrite(
          createPolicy({ allowWrite: [directory] }),
          path.join(directory, "file.txt"),
        ),
        { allowed: true },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("resolution failures", () => {
  it("denies relative requested paths", () => {
    assert.deepEqual(
      evaluateRead(createPolicy(), "relative/file.txt", "file"),
      { allowed: false, deniedPath: "relative/file.txt" },
    );
    assert.deepEqual(
      evaluateWrite(createPolicy(), "relative/file.txt"),
      { allowed: false, deniedPath: "relative/file.txt" },
    );
  });

  it("denies a cyclic requested path", async () => {
    await withTempDirectory(async (directory) => {
      const firstLink = path.join(directory, "first");
      const secondLink = path.join(directory, "second");
      await symlink(secondLink, firstLink);
      await symlink(firstLink, secondLink);
      const requestedPath = path.join(firstLink, "file.txt");

      assert.deepEqual(
        evaluateRead(createPolicy(), requestedPath, "file"),
        { allowed: false, deniedPath: requestedPath },
      );
      assert.deepEqual(
        evaluateWrite(
          createPolicy({ allowWrite: [directory] }),
          requestedPath,
        ),
        { allowed: false, deniedPath: requestedPath },
      );
    });
  });

  it("fails reads closed when any denyRead rule is cyclic", async () => {
    await withTempDirectory(async (directory) => {
      const firstLink = path.join(directory, "first");
      const secondLink = path.join(directory, "second");
      await symlink(secondLink, firstLink);
      await symlink(firstLink, secondLink);
      const requestedPath = path.join(directory, "unrelated.txt");

      assert.deepEqual(
        evaluateRead(
          createPolicy({ denyRead: [firstLink] }),
          requestedPath,
          "file",
        ),
        { allowed: false, deniedPath: requestedPath },
      );
    });
  });

  it("fails writes closed when any denyWrite rule is cyclic", async () => {
    await withTempDirectory(async (directory) => {
      const firstLink = path.join(directory, "first");
      const secondLink = path.join(directory, "second");
      await symlink(secondLink, firstLink);
      await symlink(firstLink, secondLink);
      const requestedPath = path.join(directory, "allowed.txt");

      assert.deepEqual(
        evaluateWrite(
          createPolicy({
            allowWrite: [directory],
            denyWrite: [firstLink],
          }),
          requestedPath,
        ),
        { allowed: false, deniedPath: requestedPath },
      );
    });
  });

  it("ignores cyclic allow rules", async () => {
    await withTempDirectory(async (directory) => {
      const firstLink = path.join(directory, "first");
      const secondLink = path.join(directory, "second");
      const allowedPath = path.join(directory, "allowed");
      await symlink(secondLink, firstLink);
      await symlink(firstLink, secondLink);
      await mkdir(allowedPath);

      assert.deepEqual(
        evaluateRead(
          createPolicy({
            denyRead: [directory],
            allowRead: [firstLink],
          }),
          path.join(directory, "file.txt"),
          "file",
        ),
        { allowed: false, deniedPath: directory },
      );
      assert.deepEqual(
        evaluateWrite(
          createPolicy({ allowWrite: [firstLink, allowedPath] }),
          path.join(allowedPath, "file.txt"),
        ),
        { allowed: true },
      );
    });
  });
});
