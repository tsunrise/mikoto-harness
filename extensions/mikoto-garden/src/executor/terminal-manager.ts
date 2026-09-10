import { randomInt } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JOB_LIMITS, type Delivery, type Job, type Requests } from "../protocol.ts";
import { assertLaunchIdentity, withScratchEnvironment } from "../launch.ts";
import { OutputStore, boundedText, sanitize, type LogQuota } from "./output-store.ts";
import { PipeProcess } from "./process.ts";
import { Sandbox } from "./sandbox.ts";

type Entry = {
  job: Job;
  process: PipeProcess;
  output: OutputStore;
  // A consuming operation owns this queue until ACK or cancellation releases
  // its reservation, not merely until its wait returns a result.
  queue: Promise<unknown>;
  reservation?: { unlock: () => void; request: number; completed: boolean };
};
export class TerminalManager {
  private readonly entries = new Map<number, Entry>();
  private readonly quota: LogQuota = { bytes: 0 };
  private readonly retiredWarnings = new Set<string>();
  private nextId = randomInt(1, 2 ** 40);
  private starting = 0;
  private closing = false;
  private readonly sandbox: Sandbox;
  private readonly logs: string;
  private readonly scratch: string;
  private readonly exit: (job: Job) => void;
  private readonly progress: (request: number, delivery: Delivery) => void;
  constructor(
    sandbox: Sandbox,
    logs: string,
    scratch: string,
    exit: (job: Job) => void,
    progress: (request: number, delivery: Delivery) => void = () => {},
  ) {
    this.sandbox = sandbox;
    this.logs = logs;
    this.scratch = scratch;
    this.exit = exit;
    this.progress = progress;
  }
  get(id: number): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Unknown or expired managed session ID");
    return entry;
  }
  private snapshot(entry: Entry): Job {
    return {
      ...entry.job,
      stdinOpen: entry.process.stdinOpen,
      unread: entry.output.unread,
      exit_code: entry.process.exitCode,
      exit_signal: entry.process.exitSignal,
      cleanup: entry.process.cleanupWarning,
    };
  }
  list(id?: number): { jobs: Job[]; tail?: string } {
    if (id !== undefined) {
      const entry = this.get(id);
      return { jobs: [this.snapshot(entry)], tail: entry.output.preview() };
    }
    return {
      jobs: [...this.entries.values()].map((entry) => ({
        ...this.snapshot(entry),
        cmd: boundedText(sanitize(entry.job.cmd), 512),
        cwd: boundedText(sanitize(entry.job.cwd), 1024),
      })),
    };
  }
  async spawn(
    data: Requests["spawn"],
    request: number,
    signal: AbortSignal,
    assertCurrent: () => void = () => {},
  ): Promise<Delivery> {
    if (this.closing) throw new Error("Generation closing");
    if (
      this.starting + [...this.entries.values()].filter((e) => !e.process.exited).length >=
      JOB_LIMITS.live
    ) {
      throw new Error(`Live-command capacity (${JOB_LIMITS.live}) reached`);
    }
    // Do not evict unseen output to make space. Finished/uncollected jobs use
    // the same bounded registry until a tool collects them or the session ends.
    if (this.starting + this.entries.size >= JOB_LIMITS.outstanding) {
      throw new Error(
        `Outstanding-command capacity (${JOB_LIMITS.outstanding}) reached; collect completed commands with write_stdin`,
      );
    }
    this.starting++;
    let entry: Entry | undefined;
    let cleanup: () => Promise<void> = async () => {};
    let output: OutputStore | undefined;
    const launch = withScratchEnvironment(data.launch, this.scratch);
    try {
      await this.sandbox.checkReady();
      await assertLaunchIdentity(launch);
      signal.throwIfAborted();
      const wrapped =
        launch.mode === "sandboxed" ? await this.sandbox.wrap(launch) : undefined;
      cleanup = wrapped?.cleanup ?? cleanup;
      signal.throwIfAborted();
      assertCurrent();
      if (this.closing) throw new Error("Generation closing");
      await assertLaunchIdentity(launch);
      signal.throwIfAborted();
      assertCurrent();
      const id = this.nextId++;
      output = new OutputStore(join(this.logs, `${id}.log`), this.quota);
      const job: Job = {
        id,
        cmd: launch.cmd,
        cwd: launch.cwd,
        mode: launch.mode,
        state: "running",
        started: Date.now(),
        disclosed: false,
        stdinOpen: launch.stdin,
        exit_code: null,
        exit_signal: null,
        unread: 0,
      };
      const child = new PipeProcess(
        wrapped?.argv ?? [launch.shell, launch.login ? "-lc" : "-c", launch.cmd],
        launch,
        output,
        () => {
          job.state = child.cleanupWarning === "Process spawn failed" ? "failed" : "exited";
          job.ended = Date.now();
          if (entry) this.exit(this.snapshot(entry));
        },
        cleanup,
      );
      entry = { job, process: child, output, queue: Promise.resolve() };
      this.entries.set(id, entry);
      await child.spawned();
    } catch (error) {
      if (!entry) {
        output?.close();
        await cleanup();
      }
      throw error;
    } finally {
      this.starting--;
    }
    try {
      return await this.deliver(
        entry,
        data.wait,
        data.tokens,
        request,
        signal,
        launch.capabilities,
      );
    } catch (error) {
      if (!entry.job.disclosed) await entry.process.stop();
      throw error;
    }
  }
  async input(
    data: Requests["input"],
    request: number,
    signal: AbortSignal,
    capabilities: boolean,
  ): Promise<Delivery> {
    const entry = this.get(data.id);
    const previous = entry.queue;
    let unlock!: () => void;
    entry.queue = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      signal.throwIfAborted();
      if (this.closing) throw new Error("Generation closing");
      // A preceding final ACK may have retired this entry while we queued.
      // Never resurrect it or reserve a second delivery from a detached object.
      if (this.entries.get(data.id) !== entry) {
        throw new Error("Unknown or expired managed session ID");
      }
      if (data.operation.kind !== "poll") {
        if (entry.process.exited) throw new Error("Process is no longer live");
        if (data.operation.kind === "interrupt") entry.process.interrupt();
        else {
          await entry.process.write(
            data.operation.chars,
            data.operation.kind === "eof" || data.operation.kind === "write-close",
            signal,
          );
        }
      }
      return await this.deliver(
        entry,
        data.wait,
        data.tokens,
        request,
        signal,
        capabilities,
        unlock,
      );
    } catch (error) {
      unlock();
      throw error;
    }
  }
  private async deliver(
    entry: Entry,
    wait: number,
    tokens: number,
    request: number,
    signal: AbortSignal,
    capabilities: boolean,
    release?: () => void,
  ): Promise<Delivery> {
    const started = Date.now();
    const progress = setInterval(() => {
      this.progress(request, {
        job: { ...this.snapshot(entry), cmd: entry.job.cmd.slice(0, 512) },
        chunk: "pending",
        output: entry.output.preview(),
        omitted: 0,
        log: "",
        logCapped: false,
        wall_ms: Date.now() - started,
        yielded: false,
        capabilities,
      });
    }, 250);
    const waitLifetime = new AbortController();
    try {
      await Promise.race([
        entry.process.finished,
        delay(wait, undefined, {
          signal: AbortSignal.any([signal, waitLifetime.signal]),
        }),
      ]);
    } finally {
      waitLifetime.abort();
      clearInterval(progress);
    }
    if (entry.process.exited) await entry.process.cleanupExited();
    signal.throwIfAborted();
    const result = entry.output.reserve(tokens);
    let unlock = release;
    if (!unlock) {
      entry.queue = new Promise<void>((resolve) => {
        unlock = resolve;
      });
    }
    entry.reservation = { unlock: unlock!, request, completed: entry.process.exited };
    return {
      ...result,
      job: this.snapshot(entry),
      wall_ms: Date.now() - started,
      yielded: !entry.process.exited,
      capabilities,
      request,
    };
  }
  ack(id: number, chunk: string, preserveLog = false): void {
    const entry = this.get(id);
    entry.output.ack(chunk, preserveLog);
    entry.job.disclosed = true;
    entry.job.collected = entry.reservation?.completed ?? false;
    const unlock = entry.reservation?.unlock;
    entry.reservation = undefined;
    // A yielded result followed by a quiet exit is not final-state delivery:
    // keep that job until the agent collects its completion too. Likewise,
    // previews, cancellations, and unacknowledged deliveries consume nothing.
    if (entry.process.exited && entry.job.collected && entry.output.unread === 0) {
      this.entries.delete(id);
      // Keep only distinct fixed cleanup reasons, not old job/process objects.
      // Otherwise forgetting a warned row could let shutdown falsely declare
      // cleanup complete and delete artifacts whose ownership is uncertain.
      if (entry.process.cleanupWarning) this.retiredWarnings.add(entry.process.cleanupWarning);
      else entry.output.discardUnreferencedLog();
    }
    unlock?.();
  }
  async cancel(request: number): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.reservation?.request === request) {
        entry.output.release();
        entry.reservation.unlock();
        entry.reservation = undefined;
        if (!entry.job.disclosed) await entry.process.stop();
      }
    }
  }
  async stop(id?: number, all = false): Promise<{ warnings: string[] }> {
    const entries =
      id === undefined
        ? [...this.entries.values()].filter((e) => all || e.job.disclosed)
        : [this.get(id)];
    const warnings = await Promise.all(
      entries.map(async (entry) => {
        if (!entry.process.exited) entry.job.state = "stopping";
        const warning = await entry.process.stop();
        return warning ? `Session ${entry.job.id}: ${warning}` : undefined;
      }),
    );
    return { warnings: warnings.filter((warning): warning is string => !!warning) };
  }
  async close(): Promise<{ warnings: string[] }> {
    this.closing = true;
    for (const entry of this.entries.values()) {
      entry.output.release();
      entry.reservation?.unlock();
      entry.reservation = undefined;
    }
    const result = await this.stop(undefined, true);
    this.entries.clear();
    result.warnings.push(...[...this.retiredWarnings].map((warning) => `Retired job: ${warning}`));
    return result;
  }
}
