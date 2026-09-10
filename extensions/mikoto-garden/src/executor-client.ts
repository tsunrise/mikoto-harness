import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOST_PATH, safeEnvironment } from "./launch.ts";
import {
  boundedMessage,
  operationDigest,
  type Delivery,
  type Job,
  type Requests,
  type Responses,
  type WireResponse,
} from "./protocol.ts";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  progress?: (delivery: Delivery) => void;
};
export class ExecutorClient {
  private readonly child: ChildProcess;
  private sequence = 0;
  private dead = false;
  private readonly pending = new Map<number, Pending>();
  readonly generation: string;
  private readonly event: (job: Job) => void;
  private readonly failure: () => void;
  constructor(generation: string, node: string, event: (job: Job) => void, failure: () => void) {
    this.generation = generation;
    this.event = event;
    this.failure = failure;
    this.child = fork(fileURLToPath(new URL("../dist/executor/main.js", import.meta.url)), [], {
      execPath: node,
      execArgv: [],
      env: { ...safeEnvironment(), PATH: HOST_PATH },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    this.child.on("message", (raw: unknown) => {
      if (!boundedMessage(raw)) {
        this.fail();
        return;
      }
      const message = raw as WireResponse;
      if (message.generation !== generation) return;
      if ("event" in message) {
        if (message.event === "exit") this.event(message.job);
        else {
          try {
            this.pending.get(message.id)?.progress?.(message.delivery);
          } catch {
            /* Rendering cannot affect execution authority. */
          }
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.cleanup();
      message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result);
    });
    this.child.on("disconnect", () => this.fail());
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
  }
  get available(): boolean {
    return !this.dead;
  }
  private fail(): void {
    if (this.dead) return;
    this.dead = true;
    this.rejectPending(
      "Executor disconnected; operation delivery may be uncertain. Do not replay.",
    );
    this.child.kill("SIGTERM");
    this.failure();
  }
  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
  async request<Name extends keyof Requests>(
    method: Name,
    data: Requests[Name],
    timeout = 10_000,
    signal?: AbortSignal,
    approved = false,
    progress?: (delivery: Delivery) => void,
  ): Promise<Responses[Name]> {
    if (this.dead || this.pending.size >= 240) {
      throw new Error("Command executor unavailable or busy");
    }
    signal?.throwIfAborted();
    const id = ++this.sequence;
    const message = {
      generation: this.generation,
      id,
      method,
      data,
      ...(approved
        ? {
            approval: { generation: this.generation, operation: id, digest: operationDigest(data) },
          }
        : {}),
    };
    if (!boundedMessage(message)) throw new Error("Execution IPC operation exceeds limit");
    return await new Promise<Responses[Name]>((resolve, reject) => {
      const cancel = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        reject(new Error("Command wait cancelled; already delivered input cannot be rolled back"));
        // Control traffic uses the same increasing sequence but is not replay.
        void this.request("cancel", { request: id }).catch(() => this.fail());
      };
      const timer = setTimeout(() => {
        // A timed-out mutation has uncertain delivery. Retire the executor
        // rather than replaying it or pretending its authority is synchronized.
        this.fail();
      }, timeout);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        progress,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
        },
      });
      signal?.addEventListener("abort", cancel, { once: true });
      this.child.send(message, (error) => {
        if (error) this.fail();
      });
      if (signal?.aborted) cancel();
    });
  }
  async close(): Promise<string[]> {
    if (this.dead) return ["Executor cleanup unconfirmed"];
    let warnings: string[] = [];
    try {
      warnings = (await this.request("shutdown", {}, 8000)).warnings;
    } catch {
      warnings.push("Executor cleanup unconfirmed");
    }
    this.dead = true;
    // Shutdown can finish before every in-flight request has received its
    // reply. Once dead is set, disconnect/timeout handlers intentionally do
    // nothing, so we must settle those callers and clear their timers here.
    this.rejectPending(
      "Command executor closed; operation delivery may be uncertain. Do not replay.",
    );
    if (this.child.connected) this.child.disconnect();
    return warnings;
  }
}
