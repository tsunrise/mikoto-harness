import type {
  MikotoEventEmitter,
  MikotoEscalationResult,
  MikotoPolicy,
  MikotoPolicyEscalateEvent,
} from "mikoto-types";
import type { Launch } from "./launch.ts";
import type { InputOperation, Job } from "./protocol.ts";

export function obtainPolicy(events: MikotoEventEmitter): MikotoPolicy | undefined {
  let policy: MikotoPolicy | undefined;
  let dispatching = true;
  try {
    events.emit("mikoto-policy:get-policy", {
      callback(value) {
        if (dispatching) policy ??= value;
      },
    });
  } catch {
    return undefined;
  } finally {
    dispatching = false;
  }
  try {
    if (!policy || typeof policy.diagnostics !== "function" || !policy.document().network) {
      return undefined;
    }
    const invalidSnapshot = policy
      .diagnostics()
      .some(
        (diagnostic) =>
          diagnostic.kind === "invalid_layer" ||
          diagnostic.kind === "unreadable_layer" ||
          diagnostic.kind === "canonical_rule",
      );
    if (invalidSnapshot) return undefined;
    return policy;
  } catch {
    return undefined;
  }
}
function commandSubject(command: string): readonly string[] {
  const lines = command.split("\n");
  if (lines.length === 1) return [`Command: ${command}`];
  return [
    "Command (line breaks shown separately):",
    ...lines.map((line, index) => `Line ${index + 1}: ${line || "(empty)"}`),
  ];
}
export function launchSubject(launch: Launch): readonly string[] {
  return Object.freeze([
    ...commandSubject(launch.cmd),
    `Cwd: ${launch.cwd}`,
    `Shell: ${launch.shell} ${launch.login ? "-lc" : "-c"}; stdin ${launch.stdin ? "open" : "closed"}`,
    "Execution uses host authority (unsandboxed)",
  ]);
}
export function inputSubject(job: Job, operation: InputOperation): readonly string[] {
  return Object.freeze([
    `Managed session: ${job.id}; UNSANDBOXED`,
    ...commandSubject(job.cmd),
    `Cwd: ${job.cwd}`,
    `Operation: ${operation.kind}`,
    `Exact UTF-8 input (${Buffer.byteLength(operation.chars)} bytes): ${operation.chars || "(empty)"}`,
    "Only this input/EOF/interrupt is requested; initial launch approval does not authorize continued interaction.",
  ]);
}
export async function authorize(
  events: MikotoEventEmitter,
  requestId: string,
  subject: readonly string[],
  why: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await requestEscalation(events, {
    requestId,
    source: "Mikoto Garden",
    verb: "Unsandboxed operation",
    subject,
    why,
    signal,
  });
  if (result.decision !== "approve")
    throw new Error(
      `Garden escalation rejected (${result.cause})${result.reason ? `: ${result.reason}` : ""}. No requested operation was dispatched.`,
    );
  signal.throwIfAborted();
}
/** Producer-local implementation of Policy's synchronous-claim protocol. */
export function requestEscalation(
  events: MikotoEventEmitter,
  request: Omit<MikotoPolicyEscalateEvent, "claim" | "callback">,
): Promise<MikotoEscalationResult> {
  return new Promise((resolve) => {
    let settled = false;
    let claimed = false;
    let dispatching = true;
    let synchronousResult: MikotoEscalationResult | undefined;
    const finish = (result: MikotoEscalationResult) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener("abort", abort);
      resolve(request.signal.aborted ? { decision: "reject", cause: "cancelled" } : result);
    };
    const abort = () => finish({ decision: "reject", cause: "cancelled" });
    if (request.signal.aborted) {
      abort();
      return;
    }
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      events.emit("mikoto-policy:escalate", {
        ...request,
        claim() {
          if (claimed || settled || !dispatching) return false;
          claimed = true;
          return true;
        },
        callback(result) {
          if (!claimed || settled) return;
          // A synchronous callback-then-throw must not authorize execution.
          if (dispatching) synchronousResult ??= result;
          else finish(result);
        },
      });
    } catch {
      finish({ decision: "reject", cause: "error" });
    } finally {
      dispatching = false;
    }
    if (!claimed) finish({ decision: "reject", cause: "unavailable" });
    else if (synchronousResult) finish(synchronousResult);
  });
}
