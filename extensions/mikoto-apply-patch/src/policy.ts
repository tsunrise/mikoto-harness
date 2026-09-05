import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  MikotoEventEmitter,
  MikotoPolicy,
} from "mikoto-types";

export interface ApplyPatchPolicy {
  assertCanWrite(targets: readonly string[]): Promise<void>;
}

export function installApplyPatchPolicy(
  pi: ExtensionAPI,
): ApplyPatchPolicy {
  let policy: MikotoPolicy | undefined;
  const events: MikotoEventEmitter = pi.events;

  pi.on("session_start", () => {
    policy = undefined;
    events.emit("mikoto-policy:get-policy", {
      callback(currentPolicy) {
        policy ??= currentPolicy;
      },
    });
  });

  return {
    async assertCanWrite(targets) {
      if (!policy) return;

      // Rust already returns sorted, deduplicated targets. We still deduplicate
      // here because policy enforcement should not depend on that optimization
      // remaining part of the native representation.
      for (const target of new Set(targets)) {
        let decision;
        try {
          decision = await policy.evaluateWrite(target);
        } catch (error) {
          throw new Error(
            `Mikoto Policy could not evaluate write access to ${target}; access denied. See ${policy.permissionMdPath}.`,
            { cause: error },
          );
        }

        if (!decision.allowed) {
          throw new Error(
            `Mikoto Policy denied write access to ${decision.deniedPath}. See ${policy.permissionMdPath}.`,
          );
        }
      }
    },
  };
}
