import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  MikotoEventEmitter,
  MikotoEscalationResult,
  MikotoPolicy,
  MikotoPolicyEscalateEvent,
} from "mikoto-types";

export interface ApplyPatchPolicy {
  /** Returns an invocation-bound lifetime check to repeat just before apply. */
  assertCanWrite(targets: readonly string[], requestId?: string, signal?: AbortSignal): Promise<(() => void) | void>;
}

export function installApplyPatchPolicy(
  pi: ExtensionAPI,
): ApplyPatchPolicy {
  let policy: MikotoPolicy | undefined;
  let lifetime = new AbortController();
  const events: MikotoEventEmitter = pi.events;

  pi.on("session_start", () => {
    lifetime.abort();
    lifetime = new AbortController();
    policy = undefined;
    const currentLifetime = lifetime;
    events.emit("mikoto-policy:get-policy", {
      callback(currentPolicy) {
        if (lifetime === currentLifetime && !lifetime.signal.aborted) policy ??= currentPolicy;
      },
    });
  });
  pi.on("session_shutdown", () => {
    lifetime.abort();
    policy = undefined;
  });
  pi.on("session_tree", () => {
    lifetime.abort();
    lifetime = new AbortController();
  });

  return {
    async assertCanWrite(targets, requestId = "apply_patch", callerSignal) {
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, lifetime.signal])
        : lifetime.signal;
      const assertCurrent = () => signal.throwIfAborted();
      assertCurrent();
      const currentPolicy = policy;
      if (!currentPolicy) return assertCurrent;
      const scope = [...new Set(targets)];
      const denied = new Set<string>();

      // Rust already returns sorted, deduplicated targets. We still deduplicate
      // here because policy enforcement should not depend on that optimization
      // remaining part of the native representation.
      for (const target of scope) {
        let decision;
        try {
          decision = await currentPolicy.evaluateWrite(target);
        } catch (error) {
          throw new Error(
            `Mikoto Policy could not evaluate write access to ${target}; access denied. See ${currentPolicy.permissionMdPath}.`,
            { cause: error },
          );
        }

        if (!decision.allowed) {
          denied.add(target);
        }
      }
      signal.throwIfAborted();
      if (!denied.size) return assertCurrent;
      const result = await requestEscalation(events, {
        requestId,
        source: "Mikoto Apply Patch",
        verb: "Apply Patch",
        subject: scope.map((target) => `${denied.has(target) ? "[denied] " : "[allowed] "}${target}`),
        why: "This patch needs write access to paths denied by the current policy.",
        signal,
      });
      if (result.decision !== "approve") {
        throw new Error(
          `Mikoto Policy denied write access to ${[...denied].join(", ")}; escalation rejected (${result.cause})${result.reason ? `: ${result.reason}` : "."} See ${currentPolicy.permissionMdPath}.`,
        );
      }
      signal.throwIfAborted();
      return assertCurrent;
    },
  };
}

/** Claimed, one-shot in-process delivery; no receiver must never mean a hang. */
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
        claim: () => {
          if (claimed || settled || !dispatching) return false;
          claimed = true;
          return true;
        },
        callback: (result) => {
          if (!claimed || settled) return;
          // Don't authorize until synchronous dispatch has returned normally:
          // a listener can call back and then throw in the same emit().
          if (dispatching) synchronousResult ??= result;
          else finish(result);
        },
      });
    } catch (error) {
      console.error("Mikoto Apply Patch escalation delivery failed:", error);
      finish({ decision: "reject", cause: "error" });
    } finally {
      dispatching = false;
    }
    if (!claimed) finish({ decision: "reject", cause: "unavailable" });
    else if (synchronousResult) finish(synchronousResult);
  });
}
