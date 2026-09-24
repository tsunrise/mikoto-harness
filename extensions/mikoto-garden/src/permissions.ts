import type {
  MikotoEventEmitter,
  MikotoEscalationAction,
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
export function launchAction(launch: Launch): MikotoEscalationAction {
  return {
    toolName: "exec_command",
    input: { cmd: launch.cmd, cwd: launch.cwd, shell: launch.shell,
      login: launch.login, stdin: launch.stdin, mode: launch.mode },
    context: { capabilities: launch.capabilities, cwdIdentity: launch.cwdIdentity,
      shellIdentity: launch.shellIdentity, PATH: launch.env.PATH,
      HOME: launch.env.HOME, LANG: launch.env.LANG, TERM: launch.env.TERM,
      transport: "pipes", proxyEnvironment: "cleared", scratch: "runtime-managed TMPDIR" },
  };
}
export function inputAction(job: Job, operation: InputOperation): MikotoEscalationAction {
  return {
    toolName: "write_stdin",
    input: { session_id: job.id, kind: operation.kind, chars: operation.chars },
    context: { cmd: job.cmd, cwd: job.cwd, stdinOpen: job.stdinOpen,
      state: job.state, mode: job.mode },
  };
}
export async function authorize(
  events: MikotoEventEmitter,
  requestId: string,
  action: MikotoEscalationAction,
  why: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await requestEscalation(events, {
    requestId,
    source: "Mikoto Garden",
    action,
    why,
    signal,
  });
  if (result.decision !== "approve")
    throw new Error(
      `Garden escalation rejected${result.cause === "user" ? "" : ` (${result.cause})`}${result.reason ? `: ${result.reason}` : ""}. No requested operation was dispatched.`,
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
