import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { MikotoEventEmitter } from "mikoto-types";
import type { Endpoint } from "./capability-server.ts";
import { prepareLaunch, assertLaunchIdentity } from "./launch.ts";
import { authorize, inputAction, launchAction, stopAction } from "./permissions.ts";
import {
  JOB_LIMITS,
  type Delivery,
  type InputOperation,
  type Job,
  type Requests,
} from "./protocol.ts";
import type { ExecutorClient } from "./executor-client.ts";
import { boundedText } from "./executor/output-store.ts";
import { gardenRenderers } from "./ui.ts";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reason = z
  .string()
  .max(4096)
  .refine((s) => !!s.trim());
const utf8 = (s: string) => Buffer.from(s).toString("utf8") === s;
const MIN_POLL_WAIT_MS = 10_000;
const MAX_EXEC_WAIT_MS = 30_000;
const MAX_POLL_WAIT_MS = 300_000;
const MIN_INPUT_WAIT_MS = 250;
const MAX_INPUT_WAIT_MS = 30_000;
// After stop has signalled the process group, collect its final output. The
// wait returns as soon as the process is reaped.
const STOP_COLLECT_WAIT_MS = 1_000;
const LIST_COMMAND_CHARS = 200;
export const EXEC_DEFAULT_YIELD_MS = MIN_POLL_WAIT_MS;
export const ExecInput = z
  .strictObject({
    cmd: z
      .string()
      .min(1)
      .refine((s) => !s.includes("\0") && Buffer.byteLength(s) <= 65536 && utf8(s)),
    workdir: z
      .string()
      .max(4096)
      .refine((s) => !s.includes("\0") && utf8(s))
      .optional(),
    shell: z.enum(["bash", "zsh", "sh"]).optional(),
    login: z.boolean().optional(),
    stdin: z.boolean().optional(),
    yield_time_ms: integer.optional(),
    max_output_tokens: integer.optional(),
    sandbox_permissions: z.enum(["use_default", "require_escalated"]).optional(),
    justification: reason.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.sandbox_permissions === "require_escalated") !==
      (value.justification !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Justification is required only for require_escalated",
      });
    }
  });
export type ExecInput = z.infer<typeof ExecInput>;
export const StdinInput = z.strictObject({
  session_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  chars: z
    .string()
    .refine((s) => Buffer.byteLength(s) <= 65536 && utf8(s))
    .optional(),
  close_stdin: z.boolean().optional(),
  yield_time_ms: integer.optional(),
  max_output_tokens: integer.optional(),
  justification: reason.optional(),
});
export type StdinInput = z.infer<typeof StdinInput>;
export const StopInput = z.strictObject({
  session_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  max_output_tokens: integer.optional(),
  justification: reason.optional(),
});
export type StopInput = z.infer<typeof StopInput>;
const ListInput = z.strictObject({});
const isLive = (job: Job) => job.state === "running" || job.state === "stopping";
export function formatJobList(jobs: Job[], now = Date.now()): string {
  const visible = [...jobs].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || a.started - b.started);
  if (!visible.length) return "No managed commands.";
  return visible
    .map((job) => {
      let state: string = job.state;
      if (job.exit_signal && job.exit_code === null) state = `terminated by ${job.exit_signal}`;
      else if (job.exit_code !== null) state = `exited with code ${job.exit_code}`;
      const elapsed = (((job.ended ?? now) - job.started) / 1000).toFixed(1);
      const oneLine = job.cmd.replace(/\s+/g, " ").trim();
      const chars = Array.from(oneLine);
      const cmd =
        chars.length > LIST_COMMAND_CHARS
          ? `${chars.slice(0, LIST_COMMAND_CHARS).join("")}…`
          : oneLine;
      return `${job.id} · ${job.mode} · ${state} · ${elapsed}s · ${job.unread} unread bytes · ${cmd}`;
    })
    .join("\n");
}
export function classifyInput(input: StdinInput): InputOperation {
  const chars = input.chars ?? "";
  if (chars === "\u0003") {
    if (input.close_stdin) throw new Error("Interrupt cannot be combined with close_stdin");
    return Object.freeze({ kind: "interrupt", chars });
  }
  if (chars) {
    return Object.freeze({ kind: input.close_stdin ? "write-close" : "write", chars });
  }
  return Object.freeze({ kind: input.close_stdin ? "eof" : "poll", chars });
}
const clamp = (value: number | undefined, fallback: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value ?? fallback));
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "Invalid tool arguments (unknown fields including tty are unsupported; check integer, size, and justification requirements)",
    );
  }
  return parsed.data;
}
export type ToolRuntime = {
  generation: string;
  lifetime: AbortController;
  client: ExecutorClient;
  endpoint: () => Endpoint | undefined;
  approvals: Map<number, Set<AbortController>>;
};
export function formatResult(delivery: Delivery) {
  const job = delivery.job;
  let status: string;
  if (delivery.yielded) {
    status = `Process running with session ID ${job.id}`;
  } else if (job.exit_signal && job.exit_code === null) {
    status = `Process terminated by signal ${job.exit_signal}`;
  } else {
    status = `Process exited with code ${job.exit_code}`;
  }
  let output = delivery.output;
  let omitted = delivery.omitted;
  const makeHeader = () =>
    [
      `Chunk ID: ${delivery.chunk}`,
      `Wall time: ${(delivery.wall_ms / 1000).toFixed(4)} seconds`,
      status,
      `Managed session ID: ${job.id}`,
      `Sandbox mode: ${job.mode}`,
      ...(!delivery.capabilities ? ["Capabilities: unavailable"] : []),
      ...(omitted
        ? [`Warning: ${omitted} output bytes omitted (including sanitized controls).`]
        : []),
      ...(omitted || delivery.logCapped
        ? [
            `Saved log: ${delivery.log}${delivery.logCapped ? " (saving capped)" : ""}; native file policy still applies.`,
          ]
        : []),
      ...(job.cleanup ? [`Warning: ${job.cleanup}`] : []),
      "Output:\n",
    ].join("\n");
  let header = makeHeader();
  for (;;) {
    if (Buffer.byteLength(header) > 50 * 1024 || header.split("\n").length > 2000) {
      throw new Error("Executor result header exceeds response bounds");
    }
    const next = boundedText(
      output,
      50 * 1024 - Buffer.byteLength(header),
      2001 - header.split("\n").length,
    );
    if (next === output) break;
    // Adding an omission warning/log reference itself takes space. Shrink
    // monotonically until the complete response, not just its output, fits.
    omitted += Buffer.byteLength(output) - Buffer.byteLength(next);
    output = next;
    header = makeHeader();
  }
  return {
    content: [{ type: "text" as const, text: header + output }],
    details: { ...delivery, output, omitted },
  };
}
function metadata(ctx: ExtensionContext): Record<string, string | undefined> {
  return {
    PI_SESSION_ID: ctx.sessionManager.getSessionId(),
    PI_SESSION_FILE: ctx.sessionManager.getSessionFile(),
    PI_PROVIDER: ctx.model?.provider,
    PI_MODEL: ctx.model?.id,
    PI_REASONING_LEVEL: ctx.thinkingLevel,
  };
}
export function registerGardenTools(
  pi: ExtensionAPI,
  current: () => ToolRuntime,
  collected: (id: number) => void = () => {},
): void {
  async function deliver<Name extends "spawn" | "input">(
    runtime: ToolRuntime,
    method: Name,
    data: Requests[Name],
    signal: AbortSignal,
    approved: boolean,
    update: AgentToolUpdateCallback | undefined,
  ) {
    const result = await runtime.client.request(
      method,
      data,
      data.wait + (method === "spawn" ? 20000 : 15000),
      signal,
      approved,
      (progress) =>
        update?.({
          content: [{ type: "text", text: progress.output }],
          details: progress,
        }),
    );
    try {
      // Initial cancellation must stop an undisclosed command. Later input
      // handoffs, however, are accepted once the response arrives; cancellation
      // cannot undo delivered input or retroactively cancel that handoff.
      if (method === "spawn") signal.throwIfAborted();
      const response = formatResult({ ...result, capabilities: !!runtime.endpoint() });
      // Ack means accepted for tool return, not proof of model receipt.
      await runtime.client.request("ack", {
        id: result.job.id,
        chunk: result.chunk,
        preserveLog: response.details.omitted > 0 || response.details.logCapped,
      });
      if (!result.yielded && !runtime.lifetime.signal.aborted) {
        try {
          collected(result.job.id);
        } catch {
          /* Presentation cannot undo a committed delivery. */
        }
      }
      return response;
    } catch (error) {
      if (result.request !== undefined) {
        await runtime.client.request("cancel", { request: result.request }).catch(() => {});
      }
      if (method === "spawn" && !result.job.disclosed) {
        await runtime.client.request("stop", { id: result.job.id }).catch(() => {});
      }
      throw error;
    }
  }
  const events: MikotoEventEmitter = pi.events;
  async function authorizeJob(
    runtime: ToolRuntime,
    toolCallId: string,
    job: Job,
    action: Parameters<typeof authorize>[2],
    why: string,
    signal: AbortSignal,
    target: AbortController,
  ): Promise<void> {
    // Register the pending approval so a process exit or a user stop cancels it.
    const pending = runtime.approvals.get(job.id) ?? new Set<AbortController>();
    pending.add(target);
    runtime.approvals.set(job.id, pending);
    try {
      await authorize(events, toolCallId, action, why, signal);
    } finally {
      pending.delete(target);
      if (!pending.size) runtime.approvals.delete(job.id);
    }
  }
  pi.registerTool({
    name: "exec_command",
    label: "Execute Command",
    description:
      "Run a fresh macOS sandboxed shell. Wait up to 10 seconds by default; if it is still running, return the same process as a live managed session. Pipes only; no tty. Output is capped at 50 KiB/2,000 lines.",
    promptSnippet:
      "Run a sandboxed command, waiting 10 seconds by default before returning a live managed session ID",
    parameters: Type.Object(
      {
        cmd: Type.String({ description: "Shell source, at most 64 KiB" }),
        workdir: Type.Optional(
          Type.String({ description: "Relative to Pi cwd; defaults to Pi cwd" }),
        ),
        shell: Type.Optional(StringEnum(["bash", "zsh", "sh"] as const)),
        login: Type.Optional(Type.Boolean({ description: "Default true: -lc; false: -c" })),
        stdin: Type.Optional(
          Type.Boolean({
            description: "Default false: closed stdin. True retains a writable pipe, not a PTY",
          }),
        ),
        yield_time_ms: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "Default 10000; explicit values clamp to 10000–30000. Returns earlier if the process finishes. A yield window, not a timeout",
          }),
        ),
        max_output_tokens: Type.Optional(
          Type.Integer({
            minimum: 0,
            description: "Approximate output budget, default 10000; hard limits still apply",
          }),
        ),
        sandbox_permissions: Type.Optional(
          StringEnum(["use_default", "require_escalated"] as const),
        ),
        justification: Type.Optional(
          Type.String({
            description: "Nonblank reason required only for an explicitly unsandboxed launch",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    ...gardenRenderers(),
    async execute(id, raw, callerSignal, update, ctx) {
      const input = parse(ExecInput, raw);
      const runtime = current();
      const signal = AbortSignal.any([
        runtime.lifetime.signal,
        ...(callerSignal ? [callerSignal] : []),
      ]);
      const endpoint = runtime.endpoint();
      await runtime.client.request("preflight", {}, 10000, signal);
      const jobs = await runtime.client.request("list", {}, 10000, signal);
      if (
        jobs.jobs.filter((job) => job.state === "running" || job.state === "stopping").length >=
        JOB_LIMITS.live
      ) {
        throw new Error(`Live-command capacity (${JOB_LIMITS.live}) reached`);
      }
      if (jobs.jobs.length >= JOB_LIMITS.outstanding) {
        throw new Error(
          `Outstanding-command capacity (${JOB_LIMITS.outstanding}) reached; collect completed commands with write_stdin`,
        );
      }
      const launch = await prepareLaunch(input, ctx.cwd, metadata(ctx), endpoint);
      if (launch.mode === "unsandboxed") {
        await authorize(events, id, launchAction(launch), input.justification!, signal);
      }
      signal.throwIfAborted();
      if (current() !== runtime || runtime.endpoint() !== endpoint) {
        throw new Error("Generation or capability availability changed; nothing spawned");
      }
      await assertLaunchIdentity(launch);
      // Clamp at the public tool boundary, including arguments changed by a
      // tool_call hook. The executor's wait remains a duration, not a timeout:
      // a completed process can still return before this window expires.
      const wait = clamp(
        input.yield_time_ms,
        EXEC_DEFAULT_YIELD_MS,
        MIN_POLL_WAIT_MS,
        MAX_EXEC_WAIT_MS,
      );
      return deliver(
        runtime,
        "spawn",
        {
          launch,
          wait,
          tokens: input.max_output_tokens ?? 10000,
        },
        signal,
        launch.mode === "unsandboxed",
        update,
      );
    },
  });
  pi.registerTool({
    name: "write_stdin",
    label: "Manage Command",
    description:
      "Wait for a managed command and collect unread output without sending input (omit chars), or deliver UTF-8 pipe input/EOF. Returned output is consumed; /ps previews are not. Exact Ctrl-C interrupts; use stop_command to terminate a command. Unsandboxed mutations require fresh approval; output-only waits do not.",
    promptSnippet: "Poll or send pipe input/EOF/interrupt to a managed command",
    parameters: Type.Object(
      {
        session_id: Type.Integer({ minimum: 1, description: "Managed ID, never an OS PID" }),
        chars: Type.Optional(
          Type.String({
            description:
              "Default empty poll; at most 64 KiB. Exact \\u0003 interrupts; \\u0004 is ordinary input",
          }),
        ),
        close_stdin: Type.Optional(
          Type.Boolean({
            description: "Close pipe after any input; do not combine with exact Ctrl-C",
          }),
        ),
        yield_time_ms: Type.Optional(
          Type.Integer({
            minimum: 0,
            description:
              "Poll: default 10000, clamp 10000–300000; returns earlier on completion. Input/EOF/interrupt: default 250, clamp 250–30000",
          }),
        ),
        max_output_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
        justification: Type.Optional(
          Type.String({
            description:
              "Required only for unsandboxed input, EOF, or interrupt; omit for pure polls",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    ...gardenRenderers(),
    async execute(id, raw, callerSignal, update) {
      const input = parse(StdinInput, raw);
      const operation = classifyInput(input);
      const runtime = current();
      const targetLifetime = new AbortController();
      const signal = AbortSignal.any([
        runtime.lifetime.signal,
        targetLifetime.signal,
        ...(callerSignal ? [callerSignal] : []),
      ]);
      const job = (await runtime.client.request("list", { id: input.session_id }, 10000, signal))
        .jobs[0];
      const mutation = operation.kind !== "poll";
      const elevated = mutation && job.mode === "unsandboxed";
      if (elevated !== (input.justification !== undefined)) {
        throw new Error("Justification is required only for unsandboxed input/EOF/interrupt");
      }
      if (mutation && job.state !== "running") throw new Error("Process is no longer live");
      if (mutation && operation.kind !== "interrupt" && !job.stdinOpen) {
        throw new Error("stdin is closed; launch with stdin: true");
      }
      if (elevated) {
        await authorizeJob(
          runtime,
          id,
          job,
          inputAction(job, operation),
          input.justification!,
          signal,
          targetLifetime,
        );
      }
      signal.throwIfAborted();
      if (current() !== runtime) throw new Error("Command runtime generation changed");
      // Input delivery is not a poll. Keep interactive writes/EOF/interrupts
      // responsive, while output-only waits use the same floor as a launch.
      const wait = mutation
        ? clamp(input.yield_time_ms, MIN_INPUT_WAIT_MS, MIN_INPUT_WAIT_MS, MAX_INPUT_WAIT_MS)
        : clamp(input.yield_time_ms, MIN_POLL_WAIT_MS, MIN_POLL_WAIT_MS, MAX_POLL_WAIT_MS);
      return deliver(
        runtime,
        "input",
        {
          id: job.id,
          operation,
          wait,
          tokens: input.max_output_tokens ?? 10000,
        },
        signal,
        elevated,
        update,
      );
    },
  });
  pi.registerTool({
    name: "list_commands",
    label: "List Commands",
    description:
      "List managed commands that are still running or have uncollected output, with session ID, sandbox mode, state, elapsed time, unread output bytes, and command.",
    promptSnippet: "List running or uncollected managed commands and their session IDs",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, raw, callerSignal) {
      parse(ListInput, raw ?? {});
      const runtime = current();
      const signal = AbortSignal.any([
        runtime.lifetime.signal,
        ...(callerSignal ? [callerSignal] : []),
      ]);
      const { jobs } = await runtime.client.request("list", {}, 10000, signal);
      // Undisclosed jobs belong to exec_command calls that have not returned
      // yet; their IDs were never given to the model.
      const visible = jobs.filter((job) => job.disclosed);
      return {
        content: [{ type: "text" as const, text: formatJobList(visible) }],
        details: { jobs: visible },
      };
    },
  });
  pi.registerTool({
    name: "stop_command",
    label: "Stop Command",
    description:
      "Terminate a managed command and its process group (SIGTERM, then SIGKILL), then return its final unread output. Use for hung commands or commands no longer needed. A command that already exited is collected without signalling. Stopping an unsandboxed command requires fresh approval.",
    promptSnippet: "Terminate a hung or unneeded managed command and collect its final output",
    parameters: Type.Object(
      {
        session_id: Type.Integer({ minimum: 1, description: "Managed ID, never an OS PID" }),
        max_output_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
        justification: Type.Optional(
          Type.String({
            description: "Required only when the command runs unsandboxed",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    ...gardenRenderers("stop"),
    async execute(id, raw, callerSignal, update) {
      const input = parse(StopInput, raw);
      const runtime = current();
      const targetLifetime = new AbortController();
      const signal = AbortSignal.any([
        runtime.lifetime.signal,
        targetLifetime.signal,
        ...(callerSignal ? [callerSignal] : []),
      ]);
      const job = (await runtime.client.request("list", { id: input.session_id }, 10000, signal))
        .jobs[0];
      if ((job.mode === "unsandboxed") !== (input.justification !== undefined)) {
        throw new Error("Justification is required only for unsandboxed commands");
      }
      const live = isLive(job);
      if (live && job.mode === "unsandboxed") {
        await authorizeJob(
          runtime,
          id,
          job,
          stopAction(job),
          input.justification!,
          signal,
          targetLifetime,
        );
      }
      signal.throwIfAborted();
      if (current() !== runtime) throw new Error("Command runtime generation changed");
      if (live) {
        // Pending input approvals for this job cannot apply once it is stopped.
        for (const controller of runtime.approvals.get(job.id) ?? []) controller.abort();
        // Cleanup warnings also surface through the collected job snapshot.
        await runtime.client.request("stop", { id: job.id }, 15000, signal);
      }
      return deliver(
        runtime,
        "input",
        {
          id: job.id,
          operation: { kind: "poll", chars: "" },
          wait: STOP_COLLECT_WAIT_MS,
          tokens: input.max_output_tokens ?? 10000,
        },
        signal,
        false,
        update,
      );
    },
  });
}
