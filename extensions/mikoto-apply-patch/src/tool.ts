import type {
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  APPLY_PATCH_DESCRIPTION,
  applyPatchConstrainedSampling,
  applyPatchParameters,
} from "./grammar.ts";
import { supportsApplyPatch } from "./model-support.ts";
import {
  applyPatch,
  preparePatch,
} from "./native.ts";
import type { ApplyPatchPolicy } from "./policy.ts";
import {
  renderApplyPatchCall,
  renderApplyPatchResult,
} from "./render.ts";
import type { ApplyPatchToolDetails } from "./types.ts";

export function createApplyPatchTool(
  policy: ApplyPatchPolicy,
): ToolDefinition<
  typeof applyPatchParameters,
  ApplyPatchToolDetails
> {
  return {
    name: "apply_patch",
    label: "apply_patch",
    description: APPLY_PATCH_DESCRIPTION,
    parameters: applyPatchParameters,
    constrainedSampling: applyPatchConstrainedSampling,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!supportsApplyPatch(ctx.model)) {
        throw new Error(
          "apply_patch is unavailable because this model cannot receive it as a raw grammar tool.",
        );
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      const prepared = preparePatch(ctx.cwd, params.patch);
      await policy.assertCanWrite(prepared.targets);
      const outcome = await applyPatch(prepared, signal);

      return {
        content: [
          {
            type: "text",
            text: formatOutcomeSummary(outcome),
          },
        ],
        details: outcome,
      };
    },

    renderCall(args, theme, context) {
      return renderApplyPatchCall(
        args,
        theme,
        context.expanded,
        context.isPartial || context.isError,
      );
    },

    renderResult(result, options, theme, context) {
      return renderApplyPatchResult(
        result,
        options.expanded,
        theme,
        context.isError,
      );
    },
  };
}

export function formatOutcomeSummary(
  outcome: ApplyPatchToolDetails,
): string {
  let summary = "Success. Updated the following files:\n";
  const groups = [
    { kind: "added", mark: "A" },
    { kind: "modified", mark: "M" },
    { kind: "deleted", mark: "D" },
  ] as const;

  // Codex groups paths by operation kind rather than printing patch order.
  // A move is summarized under its source path because that is the path of
  // the Update File hunk in Codex's AffectedPaths.
  for (const { kind, mark } of groups) {
    for (const change of outcome.changes) {
      if (change.kind === kind) {
        summary += `${mark} ${change.path}\n`;
      }
    }
  }
  return summary;
}
