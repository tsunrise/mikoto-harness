import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MikotoEscalationResult, MikotoPolicyEscalateEvent } from "mikoto-types";
import { showEscalation, DECISION_ENTRY } from "./ui.ts";

export type EscalationRequest = Omit<MikotoPolicyEscalateEvent, "claim" | "callback">;
export type RejectionCause = Extract<MikotoEscalationResult, { decision: "reject" }>["cause"];
export const reject = (cause: RejectionCause): MikotoEscalationResult => ({ decision: "reject", cause });

type Pending = {
  request: EscalationRequest;
  generation: number;
  controller: AbortController;
  settled: boolean;
  finish: (result: MikotoEscalationResult) => void;
};

/** One session-scoped FIFO. No approval cache, execution callbacks, or timers. */
export class EscalationBroker {
  private ctx: ExtensionContext | undefined;
  private generation = 0;
  private queue: Pending[] = [];
  private active: Pending | undefined;
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) { this.pi = pi; }

  start(ctx: ExtensionContext): void {
    this.invalidate();
    this.ctx = ctx;
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
    const pending = [...(this.active ? [this.active] : []), ...this.queue];
    this.queue = [];
    // Keep the active slot until custom() has actually closed. A new runtime
    // must not overlap a retiring dialog whose promise is still unwinding.
    for (const item of pending) item.finish(reject(cause));
  }

  request(request: EscalationRequest): Promise<MikotoEscalationResult> {
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve(reject(request.signal.aborted ? "cancelled" : "unavailable"));
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      return Promise.resolve(reject(request.signal.aborted ? "cancelled" : "non_interactive"));
    }

    const snapshot: EscalationRequest = Object.freeze({
      requestId: request.requestId,
      source: request.source,
      verb: request.verb,
      why: request.why,
      signal: request.signal,
      subject: typeof request.subject === "string"
        ? request.subject
        : Object.freeze([...request.subject]),
    });
    return new Promise((resolve) => {
      const item: Pending = {
        request: snapshot,
        generation: this.generation,
        controller: new AbortController(),
        settled: false,
        finish: (result) => {
          if (item.settled) return;
          item.settled = true;
          request.signal.removeEventListener("abort", abort);
          this.queue = this.queue.filter((queued) => queued !== item);
          if (item.generation === this.generation && this.ctx === ctx) {
            if (request.signal.aborted) result = reject("cancelled");
            try {
              this.pi.appendEntry(DECISION_ENTRY, {
                version: 1,
                requestId: snapshot.requestId,
                source: snapshot.source,
                verb: snapshot.verb,
                subject: snapshot.subject,
                why: snapshot.why,
                result,
              });
            } catch (error) {
              console.error("Mikoto Policy decision history failed:", error);
              result = reject("error");
            }
          } else {
            result = reject("shutdown");
          }
          // Closing UI can synchronously call back. Mark settled first.
          item.controller.abort();
          resolve(result);
        },
      };
      const abort = () => item.finish(reject("cancelled"));
      if (request.signal.aborted) {
        item.finish(reject("cancelled"));
      } else if (this.queue.length + (this.active ? 1 : 0) >= 32) {
        item.finish(reject("busy"));
      } else {
        request.signal.addEventListener("abort", abort, { once: true });
        this.queue.push(item);
        void this.processNextRequest();
      }
    });
  }

  private async processNextRequest(): Promise<void> {
    if (this.active || !this.ctx) return;
    const item = this.queue.shift();
    if (!item) return;
    this.active = item;
    const ctx = this.ctx;
    try {
      const result = await showEscalation(
        this.pi, ctx, item.request, item.controller.signal,
      );
      if (!item.settled && result.decision === "reject" && result.cause === "interrupted") {
        item.finish(result);
        // Escape interrupts the whole turn, including sibling requests with
        // distinct signals. Don't dequeue another dialog before aborting.
        for (const queued of [...this.queue]) queued.finish(reject("interrupted"));
        ctx.abort();
      } else {
        item.finish(result);
      }
    } catch (error) {
      console.error("Mikoto Policy escalation failed:", error);
      item.finish(reject("error"));
    } finally {
      this.active = undefined;
      void this.processNextRequest();
    }
  }
}
