import { z } from "zod";
import { inertText } from "../ui.ts";

const schema = z.strictObject({
  outcome: z.enum(["allow", "deny"]),
  risk_level: z.enum(["low", "medium", "high", "critical"]).optional(),
  user_authorization: z.enum(["unknown", "low", "medium", "high"]).optional(),
  rationale: z.string().refine((s) => Buffer.byteLength(s) <= 4096).optional(),
});
export type Assessment = {
  outcome: "allow" | "deny";
  risk_level: "low" | "medium" | "high" | "critical";
  user_authorization: "unknown" | "low" | "medium" | "high";
  rationale: string;
};

export function parseAssessment(output: string): Assessment {
  if (Buffer.byteLength(output) > 8192) throw new Error("assessment");
  let text = output.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1]!;
  const parsed = schema.parse(JSON.parse(text));
  return {
    outcome: parsed.outcome,
    risk_level: parsed.risk_level ?? (parsed.outcome === "allow" ? "low" : "high"),
    user_authorization: parsed.user_authorization ?? "unknown",
    rationale: inertText(parsed.rationale?.trim() || (parsed.outcome === "allow"
      ? "The requested operation is permitted by policy."
      : "The requested operation was rejected by policy.")),
  };
}
