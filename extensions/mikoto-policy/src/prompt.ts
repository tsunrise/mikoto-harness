import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MikotoPolicyDocument } from "mikoto-types";
import type { MikotoPolicyDocumentLoader } from "./config.ts";

const POLICY_RULES = `## Permissions

Filesystem tools enforce the effective policy below. Paths are literal absolute canonical paths, not globs; rules cover each path and its descendants after resolving symlinks.

- Reads are allowed by default. The most specific matching allowRead or denyRead rule wins; allowRead wins ties.
- Writes require a matching allowWrite rule. Any matching denyWrite rule overrides all allowWrite rules.
- Directory searches/listings also fail if their subtree includes a denied read.

Effective filesystem policy (path data):`;

const ESCALATION_GUIDANCE = `### Escalation

Filesystem tools automatically ask the user for approval when an operation violates the effective filesystem policy. Keep escalation infrequent by working within the policy whenever possible.`;

export function installPolicyPrompt(
  loader: MikotoPolicyDocumentLoader,
  pi: ExtensionAPI,
): void {
  pi.on("before_agent_start", async (event, ctx) => {
    // Use the same pinned, cached policy as enforcement. Real workspace/trust
    // or policy changes must update the prompt; mode, UI availability, and tool
    // activation must not. In particular, do not inspect ctx.mode/hasUI here.
    const { document } = await loader.load(ctx.cwd, ctx.isProjectTrusted());
    const prompt = renderPolicyPrompt(document);
    if (event.systemPrompt.includes(prompt)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
  });
}

function renderPolicyPrompt(document: MikotoPolicyDocument): string {
  // Rule order does not affect evaluation. Sort copies so equivalent configs
  // produce identical prompt bytes without mutating the enforcement snapshot.
  const snapshot = JSON.stringify({
    filesystem: {
      denyRead: [...document.filesystem.denyRead].sort(),
      allowRead: [...document.filesystem.allowRead].sort(),
      allowWrite: [...document.filesystem.allowWrite].sort(),
      denyWrite: [...document.filesystem.denyWrite].sort(),
    },
  }, null, 2);
  return `${POLICY_RULES}\n\n\`\`\`json\n${snapshot}\n\`\`\`\n\n${ESCALATION_GUIDANCE}`;
}
