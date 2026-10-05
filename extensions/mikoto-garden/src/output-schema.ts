import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

// Keep the script-facing result independent of transcript formatting and
// executor bookkeeping (ACKs, reservations, and private request IDs).
export const commandOutputSchema = Type.Object({
  session_id: Type.Integer(),
  output: Type.String(),
  running: Type.Boolean(),
  exit_code: Type.Union([Type.Integer(), Type.Null()]),
  exit_signal: Type.Union([Type.String(), Type.Null()]),
  sandbox_mode: StringEnum(["sandboxed", "unsandboxed"]),
  wall_time_seconds: Type.Number(),
  truncated: Type.Boolean(),
  omitted_bytes: Type.Integer(),
  full_output_path: Type.Optional(Type.String()),
  log_capped: Type.Boolean(),
});

export const jobListOutputSchema = Type.Object({
  jobs: Type.Array(Type.Object({
    session_id: Type.Integer(),
    sandbox_mode: StringEnum(["sandboxed", "unsandboxed"]),
    state: StringEnum(["running", "stopping", "exited", "failed"]),
    command: Type.String(),
    unread_bytes: Type.Integer(),
    exit_code: Type.Union([Type.Integer(), Type.Null()]),
    exit_signal: Type.Union([Type.String(), Type.Null()]),
  })),
});
