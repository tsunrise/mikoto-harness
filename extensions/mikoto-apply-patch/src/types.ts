import type { ApplyPatchOutcome } from "./native.ts";

export type ApplyPatchToolDetails = ApplyPatchOutcome;

export type PatchPreviewKind = "add" | "update" | "delete";

export interface PatchPreviewFile {
  kind: PatchPreviewKind;
  path: string;
  movePath?: string;
  additions: number;
  deletions: number;
}

export interface PatchPreview {
  files: PatchPreviewFile[];
  truncated: boolean;
}
