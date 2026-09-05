import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createApplyPatchTool } from "../src/tool.ts";

const compatibleContext = (cwd: string) =>
  ({
    cwd,
    model: {
      provider: "openai",
      api: "openai-responses",
      id: "gpt-5.6",
      compat: { supportsOpenAIGrammarTools: true },
    },
  }) as unknown as ExtensionContext;

it("checks every prepared target before native application", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "mikoto-apply-patch-tool-"),
  );
  t.after(async () => {
    await rm(root, { recursive: true });
  });
  const target = join(root, "created.txt");
  const canonicalTarget = join(await realpath(root), "created.txt");
  const checked: string[][] = [];
  const tool = createApplyPatchTool({
    async assertCanWrite(targets) {
      checked.push([...targets]);
      await assert.rejects(access(target));
    },
  });

  const result = await tool.execute(
    "call-1",
    {
      patch: [
        "*** Begin Patch",
        "*** Add File: created.txt",
        "+hello",
        "*** End Patch",
      ].join("\n"),
    },
    undefined,
    undefined,
    compatibleContext(root),
  );

  assert.deepEqual(checked, [[canonicalTarget]]);
  assert.equal(await readFile(target, "utf8"), "hello\n");
  assert.equal(
    result.content[0]?.type === "text"
      ? result.content[0].text
      : undefined,
    "Success. Updated the following files:\nA created.txt\n",
  );
  assert.equal(result.details.changes[0]?.path, "created.txt");
  assert.match(result.details.changes[0]?.diff ?? "", /^\+1 hello$/m);
});

it("does not consume the prepared plan when policy denies it", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "mikoto-apply-patch-denied-"),
  );
  t.after(async () => {
    await rm(root, { recursive: true });
  });
  const target = join(root, "denied.txt");
  const tool = createApplyPatchTool({
    async assertCanWrite() {
      throw new Error("denied by test policy");
    },
  });

  await assert.rejects(
    tool.execute(
      "call-2",
      {
        patch: [
          "*** Begin Patch",
          "*** Add File: denied.txt",
          "+blocked",
          "*** End Patch",
        ].join("\n"),
      },
      undefined,
      undefined,
      compatibleContext(root),
    ),
    /denied by test policy/,
  );
  await assert.rejects(access(target));
});

it("presents both canonical move paths to policy before mutation", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "mikoto-apply-patch-move-"),
  );
  t.after(async () => {
    await rm(root, { recursive: true });
  });
  const source = join(root, "source.txt");
  const destination = join(root, "destination.txt");
  const canonicalRoot = await realpath(root);
  await writeFile(source, "old\n");
  const checked: string[][] = [];
  const tool = createApplyPatchTool({
    async assertCanWrite(targets) {
      checked.push([...targets]);
      throw new Error("stop after policy");
    },
  });

  await assert.rejects(
    tool.execute(
      "call-3",
      {
        patch: [
          "*** Begin Patch",
          "*** Update File: source.txt",
          "*** Move to: destination.txt",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      undefined,
      undefined,
      compatibleContext(root),
    ),
    /stop after policy/,
  );

  assert.deepEqual(checked, [
    [
      join(canonicalRoot, "destination.txt"),
      join(canonicalRoot, "source.txt"),
    ],
  ]);
  assert.equal(await readFile(source, "utf8"), "old\n");
  await assert.rejects(access(destination));
});
