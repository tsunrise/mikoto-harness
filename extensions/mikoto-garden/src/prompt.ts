import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MikotoPolicyDocument } from "mikoto-types";

const GUIDANCE = `<sandbox>
exec_command runs in a sandbox governed by the active policy (see the permission block for
filesystem and network rules). Escalation runs outside the sandbox with host
authority and requires manual user approval for each launch or later
input/EOF/interrupt; polling does not. Never bypass a denial or rejected approval.

Commands receive a shared, writable temporary directory in \`$TMPDIR\`. Files
there persist across sandboxed and elevated commands, but the directory is
disposable: its contents are no longer available after reload or restart. Use
it for temporary intermediate files, not as the sole copy of important results;
copy those to an allowed durable path.

While a command runs, do meaningful non-overlapping work first. If none remains,
poll with a long wait instead of repeatedly polling. If a command is hung (for
example, waiting for a browser or login that cannot complete in the sandbox) or
no longer needed, terminate it with stop_command instead of leaving it running;
list_commands recovers session IDs.
</sandbox>`;
const UNAVAILABLE = `<sandbox>
No valid policy snapshot is available. Command execution, including escalation, is unavailable. Never bypass this through another tool or user-shell execution path.
</sandbox>`;

export function renderGardenPrompt(document?: MikotoPolicyDocument): string {
  return document ? GUIDANCE : UNAVAILABLE;
}

export function installGardenPrompt(
  pi: ExtensionAPI,
  snapshot: () => MikotoPolicyDocument | undefined,
): void {
  pi.on("before_agent_start", (event) => {
    const block = renderGardenPrompt(snapshot());
    if (event.systemPrompt.includes(block)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });
}
