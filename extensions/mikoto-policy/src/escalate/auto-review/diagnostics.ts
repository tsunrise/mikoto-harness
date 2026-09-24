import { inertText } from "../ui.ts";
import { TOOL_CALLS } from "./model.ts";

export type ReviewFailure = "missing_model" | "input_budget" | "tool_arguments" | "tool_budget" |
  "round_budget" | "assessment_attempts" | "provider_terminal" | "provider_or_review_failure" |
  "policy_diagnostics" | "cancelled" | "deadline";
type InvestigationStatus = "pending" | "ok" | "denied" | "missing" | "failed" | "cancelled";
type Investigation = {
  tool: string;
  path?: string;
  canonicalPath?: string;
  status: InvestigationStatus;
  truncated?: boolean;
};
type ReviewDiagnostic = {
  requestId: string;
  toolName: string;
  modelCalls: number;
  investigations: Investigation[];
  status: "active" | "completed" | "failed";
  failure?: ReviewFailure;
};
export type ReviewTrace = {
  modelCall(): void;
  investigation(name: string, args: unknown): (result: unknown, failed?: "failed" | "cancelled") => void;
  finish(failure?: ReviewFailure): void;
};

// Even metadata is untrusted display text. Bound it before escaping so a bad
// tool argument cannot turn this small, optional trace into an unbounded log.
const display = (text: string) => inertText(text.slice(0, 2048));
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

/** Last active review only, opt-in and memory-only; never a decision history. */
export class ReviewDiagnostics {
  private enabled = false;
  private current: ReviewDiagnostic | undefined;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.current = undefined;
  }

  snapshot(): { enabled: boolean; review?: ReviewDiagnostic } {
    return { enabled: this.enabled, ...(this.current ? { review: structuredClone(this.current) } : {}) };
  }

  begin(requestId: string, toolName: string): ReviewTrace | undefined {
    if (!this.enabled) return undefined;
    const review: ReviewDiagnostic = {
      requestId: display(requestId), toolName: display(toolName),
      modelCalls: 0, investigations: [], status: "active",
    };
    this.current = review;
    const active = () => this.enabled && this.current === review && review.status === "active";
    return {
      modelCall: () => { if (active()) review.modelCalls++; },
      investigation: (name, args) => {
        if (!active() || review.investigations.length >= TOOL_CALLS) return () => {};
        const path = object(args).path;
        const entry: Investigation = {
          tool: display(name), ...(typeof path === "string" ? { path: display(path) } : {}), status: "pending",
        };
        review.investigations.push(entry);
        return (result, failed) => {
          if (!active() || entry.status !== "pending") return;
          const metadata = object(result);
          entry.status = failed ?? (metadata.error === "permission_denied" ? "denied" :
            metadata.error ? "failed" : metadata.missing === true ? "missing" : "ok");
          if (typeof metadata.path === "string") entry.canonicalPath = display(metadata.path);
          if (metadata.incomplete === true || metadata.truncated === true) entry.truncated = true;
        };
      },
      finish: (failure) => {
        if (!active()) return;
        review.status = failure ? "failed" : "completed";
        if (failure) review.failure = failure;
        // An abort can detach a still-pending tool. Its late result must neither
        // change this trace nor recreate one after off/reload/session changes.
        for (const entry of review.investigations) {
          if (entry.status === "pending") entry.status = failure === "cancelled" || failure === "deadline"
            ? "cancelled" : "failed";
        }
      },
    };
  }
}
