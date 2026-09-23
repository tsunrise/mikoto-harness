import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MikotoPolicyDocument } from "mikoto-types";
import type { MikotoPolicyDocumentLoader } from "./config.ts";

const POLICY_GUIDANCE = `Filesystem: Reads are allowed by default; the most specific allowRead or denyRead match wins, and allowRead wins ties. Writes require allowWrite, and denyWrite always wins.

Network: Access is denied by default; allowedDomains grants matching destinations unless deniedDomains matches. Garden's exact live capability endpoint is the only automatic localhost exception.`;

const ESCALATION_GUIDANCE = "Each escalation requires manual user action, so repeated requests are disruptive. Keep escalation infrequent by working within the policy whenever possible. Tools without an explicit escalation parameter automatically escalate policy violations.";

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
    network: {
      allowedDomains: [...document.network.allowedDomains].sort(),
      deniedDomains: [...document.network.deniedDomains].sort(),
    },
  }, null, 2)
    // JSON escapes preserve the original values when parsed, while ensuring
    // paths and domains cannot introduce XML markup, entities, or invalid characters.
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\ufffe", "\\ufffe")
    .replaceAll("\uffff", "\\uffff");
  return `<permission>
<snapshot format="json">
${snapshot}
</snapshot>
<rules>
${POLICY_GUIDANCE}
</rules>
<escalation>
${ESCALATION_GUIDANCE}
</escalation>
</permission>`;
}
