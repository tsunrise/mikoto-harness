import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installApplyPatchPolicy } from "./policy.ts";
import { createApplyPatchTool } from "./tool.ts";
import { installApplyPatchToolState } from "./tool-state.ts";

export default function mikotoApplyPatch(pi: ExtensionAPI): void {
  const policy = installApplyPatchPolicy(pi);
  pi.registerTool(createApplyPatchTool(policy));
  installApplyPatchToolState(pi);
}
