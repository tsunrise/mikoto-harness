import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { supportsApplyPatch } from "./model-support.ts";

const APPLY_PATCH = "apply_patch";
const REPLACED_TOOLS = ["edit", "write"] as const;

type ReplacedTool = (typeof REPLACED_TOOLS)[number];
type ReplacedToolState = Partial<Record<ReplacedTool, number>>;

export function installApplyPatchToolState(pi: ExtensionAPI): void {
  let replacedTools: ReplacedToolState | undefined;

  function synchronize(ctx: ExtensionContext): void {
    const active = pi.getActiveTools();

    if (supportsApplyPatch(ctx.model)) {
      if (!replacedTools) {
        replacedTools = {};
        for (const tool of REPLACED_TOOLS) {
          const index = active.indexOf(tool);
          if (index >= 0) replacedTools[tool] = index;
        }
      }

      const next = active.filter(
        (name) => !REPLACED_TOOLS.includes(name as ReplacedTool),
      );
      if (!next.includes(APPLY_PATCH)) next.push(APPLY_PATCH);
      pi.setActiveTools(next);
      return;
    }

    const next = active.filter((name) => name !== APPLY_PATCH);
    const toolsToRestore = Object.entries(replacedTools ?? {})
      .map(([name, index]) => ({
        name: name as ReplacedTool,
        index,
      }))
      .sort((left, right) => left.index - right.index);
    for (const { name, index } of toolsToRestore) {
      if (!next.includes(name)) {
        next.splice(Math.min(index, next.length), 0, name);
      }
    }
    replacedTools = undefined;
    pi.setActiveTools(next);
  }

  pi.on("session_start", (_event, ctx) => {
    synchronize(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    synchronize(ctx);
  });
}
