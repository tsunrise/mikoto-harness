import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MikotoEscalationResult, MikotoPolicyEscalateEvent } from "mikoto-types";
import type { MikotoPolicyLoadResult } from "../config.ts";
import { AutoReviewer, type DecisionBackend } from "./auto-review/index.ts";
import { ReviewDiagnostics } from "./auto-review/diagnostics.ts";
import { abortable, DEADLINE_MS } from "./auto-review/model.ts";
import type { ContextFiles } from "./auto-review/context.ts";
import { showEscalation } from "./ui.ts";

export type EscalationRequest = Omit<MikotoPolicyEscalateEvent, "claim" | "callback">;
export type RejectionCause = Extract<MikotoEscalationResult, { decision: "reject" }>["cause"];
export const reject = (cause: RejectionCause): MikotoEscalationResult => ({ decision: "reject", cause });

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

type Pending = {
  request: EscalationRequest;
  controller: AbortController;
  settled: boolean;
  finish: (result: MikotoEscalationResult) => void;
};

/** One session-scoped FIFO; the producer always owns execution. */
export class EscalationBroker {
  readonly reviewDiagnostics = new ReviewDiagnostics();
  private ctx: ExtensionContext | undefined;
  private loaded: MikotoPolicyLoadResult | undefined;
  private review: DecisionBackend | undefined;
  private generation = 0;
  private queue: Pending[] = [];
  private active: Pending | undefined;
  private contextFiles: ContextFiles = [];

  setContextFiles(files: ContextFiles): void {
    this.contextFiles = files.map((file) => Object.freeze({ path: file.path, content: file.content }));
  }

  private readonly pi: ExtensionAPI;
  private readonly backend: DecisionBackend | undefined;
  constructor(pi: ExtensionAPI, backend?: DecisionBackend) {
    this.pi = pi;
    this.backend = backend;
  }

  start(ctx: ExtensionContext, loaded: MikotoPolicyLoadResult): void {
    this.invalidate();
    this.ctx = ctx;
    this.loaded = loaded;
    this.review = this.backend ?? new AutoReviewer(ctx, loaded, this.lifetime(), () =>
      this.pi.getAllTools().some((tool) => tool.name === "request_user_input" &&
        /(?:^|[/\\])mikoto-question(?:[/\\]|$)/.test(tool.sourceInfo.path ?? "")),
      () => this.contextFiles, this.reviewDiagnostics).review;
  }

  /** Callers capture this before awaiting policy or authorization. */
  lifetime(): () => void {
    const generation = this.generation;
    return () => {
      if (!this.ctx || generation !== this.generation) {
        throw new Error("Mikoto Policy operation cancelled: runtime changed.");
      }
    };
  }

  invalidate(cause: RejectionCause = "shutdown"): void {
    this.generation++;
    this.ctx = undefined;
    this.loaded = undefined;
    this.review = undefined;
    this.contextFiles = [];
    this.reviewDiagnostics.setEnabled(false);
    const pending = [...(this.active ? [this.active] : []), ...this.queue];
    this.queue = [];
    // Manual UI retains its slot until custom() closes. Automatic work races
    // abort and releases the slot even when its provider ignores cancellation.
    for (const item of pending) item.finish(reject(cause));
  }

  request(request: EscalationRequest): Promise<MikotoEscalationResult> {
    if (request.signal.aborted) return Promise.resolve(reject("cancelled"));
    const ctx = this.ctx;
    const loaded = this.loaded;
    if (!ctx || !loaded) return Promise.resolve(reject("unavailable"));
    const mode = loaded.settings.escalation;
    let snapshot: EscalationRequest;
    try {
      // The bus is trusted, not runtime-schema-validated. JSON serialization is
      // also the admission boundary: never retain caller-owned nested references.
      snapshot = Object.freeze({
        requestId: request.requestId, source: request.source, why: request.why,
        action: freeze(JSON.parse(JSON.stringify(request.action))),
        signal: request.signal,
      });
    } catch {
      console.error("Mikoto Policy escalation: action_snapshot");
      return Promise.resolve(reject("error"));
    }
    if (mode === "always-deny") return Promise.resolve({
      decision: "reject", cause: "user", reason: "Escalation is disabled by policy.",
    });
    if (mode === "ask-me" && (ctx.mode !== "tui" || !ctx.hasUI)) return Promise.resolve(reject("non_interactive"));
    if (mode === "auto-review" && loaded.diagnostics.some((d) =>
      ["invalid_layer", "unreadable_layer", "canonical_rule"].includes(d.kind))) {
      console.error("Mikoto Policy auto-review: policy_diagnostics");
      return Promise.resolve(reject("error"));
    }
    const generation = this.generation;
    return new Promise((resolve) => {
      const item: Pending = {
        request: snapshot, controller: new AbortController(), settled: false,
        finish: (result) => {
          if (item.settled) return;
          item.settled = true;
          request.signal.removeEventListener("abort", abort);
          this.queue = this.queue.filter((queued) => queued !== item);
          if (generation !== this.generation || this.ctx !== ctx) result = reject("shutdown");
          else if (request.signal.aborted) result = reject("cancelled");
          item.controller.abort();
          resolve(result);
        },
      };
      const abort = () => item.finish(reject("cancelled"));
      if (request.signal.aborted) item.finish(reject("cancelled"));
      else if (this.queue.length + (this.active ? 1 : 0) >= 32) item.finish(reject("busy"));
      else {
        request.signal.addEventListener("abort", abort, { once: true });
        this.queue.push(item);
        void this.processNextRequest();
      }
    });
  }

  private async processNextRequest(): Promise<void> {
    if (this.active || !this.ctx || !this.loaded) return;
    const item = this.queue.shift();
    if (!item) return;
    this.active = item;
    const ctx = this.ctx;
    const mode = this.loaded.settings.escalation;
    // Bound the backend boundary too, so even a replacement/test backend that
    // ignores abort cannot keep the serial slot forever.
    const deadline = mode === "auto-review" ? setTimeout(() => {
      console.error("Mikoto Policy auto-review: deadline");
      item.finish(reject("error"));
    }, DEADLINE_MS) : undefined;
    try {
      const result = mode === "auto-review"
        ? await abortable(this.review!(item.request, item.controller.signal), item.controller.signal)
        : await showEscalation(this.pi, ctx, item.request.action.toolName, item.controller.signal);
      if (mode === "ask-me" && !item.settled && result.decision === "reject" && result.cause === "interrupted") {
        item.finish(result);
        for (const queued of [...this.queue]) queued.finish(reject("interrupted"));
        ctx.abort();
      } else item.finish(result);
    } catch {
      if (!item.settled) {
        console.error("Mikoto Policy escalation: backend_failed");
        item.finish(reject("error"));
      }
    } finally {
      clearTimeout(deadline);
      this.active = undefined;
      void this.processNextRequest();
    }
  }
}
