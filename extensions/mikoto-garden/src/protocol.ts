import { createHash } from "node:crypto";
import type { MikotoPolicyDocument } from "mikoto-types";
import type { Launch, SandboxMode } from "./launch.ts";

export const CONTRACT = "garden-pipes-2";
export const MAX_IPC_BYTES = 512 * 1024;
export const JOB_LIMITS = Object.freeze({ live: 64, outstanding: 128 });
export type InputOperation = Readonly<{
  kind: "poll" | "write" | "write-close" | "eof" | "interrupt";
  chars: string;
}>;
export type Approval = Readonly<{ generation: string; operation: number; digest: string }>;
export type Job = {
  id: number;
  mode: SandboxMode;
  state: "running" | "stopping" | "exited" | "failed";
  cmd: string;
  cwd: string;
  started: number;
  ended?: number;
  disclosed: boolean;
  stdinOpen: boolean;
  exit_code: number | null;
  exit_signal: string | null;
  unread: number;
  cleanup?: string;
  collected?: boolean;
};
export type Delivery = {
  job: Job;
  chunk: string;
  output: string;
  omitted: number;
  log: string;
  logCapped: boolean;
  wall_ms: number;
  yielded: boolean;
  capabilities: boolean;
  request?: number;
};
export type Requests = {
  init: {
    contract: string;
    policy: MikotoPolicyDocument;
    endpoint?: { port: number };
    runtimeParent: string;
  };
  preflight: Record<string, never>;
  spawn: { launch: Launch; wait: number; tokens: number };
  input: { id: number; operation: InputOperation; wait: number; tokens: number };
  ack: { id: number; chunk: string; preserveLog?: boolean };
  cancel: { request: number };
  list: { id?: number };
  stop: { id?: number; all?: boolean };
  revoke: Record<string, never>;
  shutdown: Record<string, never>;
};
export type Responses = {
  init: { diagnostics: string[] };
  preflight: null;
  spawn: Delivery;
  input: Delivery;
  ack: null;
  cancel: null;
  list: { jobs: Job[]; tail?: string };
  stop: { warnings: string[] };
  revoke: null;
  shutdown: { warnings: string[] };
};
export type Request<Name extends keyof Requests = keyof Requests> = {
  generation: string;
  id: number;
  method: Name;
  data: Requests[Name];
  approval?: Approval;
};
export type WireResponse =
  | {
      generation: string;
      id: number;
      result?: Responses[keyof Responses];
      error?: string;
    }
  | { generation: string; event: "exit"; job: Job }
  | { generation: string; event: "progress"; id: number; delivery: Delivery };

export function operationDigest(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
export function boundedMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= MAX_IPC_BYTES;
  } catch {
    return false;
  }
}
// Mutations are never replayed. Adapter IDs increase at dispatch, not before
// human approval. The executor consumes a high-water mark before dispatch, so
// bounded accounting cannot make an old operation/approval valid again.
// Output is reserved until ack; this is not durable exactly-once delivery to Pi.
