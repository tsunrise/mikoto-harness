import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Tool } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";

import {
  APPLY_PATCH_DESCRIPTION,
  APPLY_PATCH_GRAMMAR,
} from "../src/grammar.ts";
import { supportsApplyPatch } from "../src/model-support.ts";
import { ApplyPatchChangeKind } from "../src/native.ts";
import type { ApplyPatchPolicy } from "../src/policy.ts";
import {
  createApplyPatchTool,
  formatOutcomeSummary,
} from "../src/tool.ts";

const policy: ApplyPatchPolicy = {
  async assertCanWrite() {},
};

const compatibleModel = {
  provider: "openai",
  api: "openai-responses",
  id: "gpt-5.6",
  compat: { supportsOpenAIGrammarTools: true },
};

describe("apply_patch tool transport", () => {
  it("registers Codex's exact description and Lark grammar", () => {
    const tool = createApplyPatchTool(policy);

    assert.equal(tool.name, "apply_patch");
    assert.equal(tool.label, "apply_patch");
    assert.equal(tool.description, APPLY_PATCH_DESCRIPTION);
    assert.equal(tool.executionMode, "sequential");
    assert.equal(tool.promptSnippet, undefined);
    assert.equal(tool.promptGuidelines, undefined);
    assert.deepEqual(tool.constrainedSampling, {
      type: "grammar",
      variants: { openai_lark: APPLY_PATCH_GRAMMAR },
    });
    assert.deepEqual(tool.parameters.required, ["patch"]);
    assert.equal(tool.parameters.properties.patch.type, "string");
    assert.equal(
      (tool.parameters as unknown as { additionalProperties?: unknown })
        .additionalProperties,
      false,
    );
  });

  it("serializes as a raw Responses custom tool without parameters", () => {
    const tool = createApplyPatchTool(policy);
    const [serialized] = convertResponsesTools(
      [tool as Tool],
      { supportsOpenAIGrammarTools: true },
    );

    assert.deepEqual(serialized, {
      type: "custom",
      name: "apply_patch",
      description: APPLY_PATCH_DESCRIPTION,
      format: {
        type: "grammar",
        syntax: "lark",
        definition: APPLY_PATCH_GRAMMAR,
      },
    });
    assert.equal("parameters" in (serialized as object), false);
  });

  it("formats the outcome summary exactly like Codex", () => {
    const summary = formatOutcomeSummary({
      changes: [
        {
          kind: ApplyPatchChangeKind.Deleted,
          path: "deleted.txt",
          additions: 0,
          deletions: 1,
          diff: "-1 deleted\n",
        },
        {
          kind: ApplyPatchChangeKind.Modified,
          path: "source.txt",
          movePath: "destination.txt",
          additions: 1,
          deletions: 1,
          diff: "-1 old\n+1 new\n",
        },
        {
          kind: ApplyPatchChangeKind.Added,
          path: "first-added.txt",
          additions: 1,
          deletions: 0,
          diff: "+1 first\n",
        },
        {
          kind: ApplyPatchChangeKind.Modified,
          path: "modified.txt",
          additions: 1,
          deletions: 1,
          diff: "-1 before\n+1 after\n",
        },
        {
          kind: ApplyPatchChangeKind.Added,
          path: "second-added.txt",
          additions: 1,
          deletions: 0,
          diff: "+1 second\n",
        },
      ],
    });

    assert.equal(
      summary,
      [
        "Success. Updated the following files:",
        "A first-added.txt",
        "A second-added.txt",
        "M source.txt",
        "M modified.txt",
        "D deleted.txt",
        "",
      ].join("\n"),
    );
  });
});

describe("model support", () => {
  it("requires an allowlisted raw adapter and its capability flag", () => {
    for (const api of [
      "openai-responses",
      "openai-codex-responses",
      "azure-openai-responses",
      "openai-completions",
    ]) {
      assert.equal(
        supportsApplyPatch({ ...compatibleModel, api } as never),
        true,
      );
    }

    assert.equal(
      supportsApplyPatch({
        ...compatibleModel,
        api: "anthropic-messages",
      } as never),
      false,
    );
    assert.equal(
      supportsApplyPatch({
        ...compatibleModel,
        api: "unknown-adapter",
      } as never),
      false,
    );
    assert.equal(
      supportsApplyPatch({
        ...compatibleModel,
        compat: {},
      } as never),
      false,
    );
    assert.equal(supportsApplyPatch(undefined), false);
  });
});
