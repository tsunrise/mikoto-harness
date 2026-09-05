import type { ConstrainedSamplingConfig } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const APPLY_PATCH_DESCRIPTION =
  "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.";

export const APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export const applyPatchParameters = Type.Object(
  {
    patch: Type.String({
      description: "Raw Codex apply_patch text. Do not wrap it in JSON.",
    }),
  },
  { additionalProperties: false },
);

export type ApplyPatchInput = Static<typeof applyPatchParameters>;

export const applyPatchConstrainedSampling = {
  type: "grammar",
  variants: {
    openai_lark: APPLY_PATCH_GRAMMAR,
  },
} satisfies ConstrainedSamplingConfig;
