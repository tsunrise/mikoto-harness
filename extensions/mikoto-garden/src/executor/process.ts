import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { HOST_PATH, type Launch } from "../launch.ts";
import { OutputStore } from "./output-store.ts";

const exec = promisify(execFile);
type Identity = { pid: number; parent: number; group: number; stamp: string };
async function processTable(): Promise<Identity[]> {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
    timeout: 1000,
    maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin" },
  });
  return stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match
        ? [{ pid: +match[1], parent: +match[2], group: +match[3], stamp: match[4] }]
        : [];
    });
}

export class PipeProcess {
  readonly child: ChildProcess;
  readonly finished: Promise<void>;
  stdinOpen: boolean;
  exitCode: number | null = null;
  exitSignal: string | null = null;
  exited = false;
  cleanupWarning: string | undefined;
  private readonly owned = new Map<number, Identity>();
  private scanning = false;
  private timer: ReturnType<typeof setInterval>;
  private finish!: () => void;
  private settled = false;
  private complete = false;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onExit: () => void;
  private readonly cleanup: () => Promise<void>;
  private finalCleanup: Promise<void> | undefined;

  constructor(
    argv: string[],
    launch: Launch,
    output: OutputStore,
    onExit: () => void,
    cleanup: () => Promise<void>,
  ) {
    this.onExit = onExit;
    this.cleanup = cleanup;
    this.stdinOpen = launch.stdin;
    this.finished = new Promise((resolve) => {
      this.finish = resolve;
    });
    this.child = spawn(argv[0], argv.slice(1), {
      // SRT's generated Unix command starts with `env`. Resolve that host
      // helper only through system directories, never a workload-writable PATH.
      // The inner payload restores the captured workload PATH after sandboxing.
      cwd: launch.cwd,
      env: launch.mode === "sandboxed" ? { ...launch.env, PATH: HOST_PATH } : launch.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!launch.stdin) this.child.stdin!.end();
    this.child.stdin!.on("error", () => {
      this.stdinOpen = false;
    });
    this.child.stdout!.on("data", (chunk: Buffer) => output.append(chunk, 0));
    this.child.stderr!.on("data", (chunk: Buffer) => output.append(chunk, 1));
    this.timer = setInterval(() => void this.track(), 500);
    void this.track();
    const settle = async () => {
      if (this.settled) return;
      this.settled = true;
      clearInterval(this.timer);
      clearTimeout(this.drainTimer);
      output.close();
      await this.cleanup().catch(() => {
        this.cleanupWarning = "Sandbox wrapper cleanup unconfirmed";
      });
      this.complete = true;
      this.finish();
      this.onExit();
    };
    this.child.once("error", () => {
      this.exited = true;
      this.stdinOpen = false;
      this.cleanupWarning = "Process spawn failed";
      void settle();
    });
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      this.stdinOpen = false;
      this.exitCode = code;
      this.exitSignal = signal;
      clearInterval(this.timer);
      // Root exit is not proof that inherited pipes will ever reach EOF.
      this.drainTimer = setTimeout(() => {
        this.cleanupWarning = "Final pipe drain capped; descendant cleanup unconfirmed";
        this.child.stdout?.destroy();
        this.child.stderr?.destroy();
        void settle();
      }, 500);
    });
    this.child.once("close", () => void settle());
  }

  async spawned(): Promise<void> {
    if (this.child.pid) return;
    await new Promise<void>((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", () => reject(new Error("Command spawn failed")));
    });
  }
  private async track(): Promise<void> {
    if (this.scanning || this.exited || !this.child.pid) return;
    this.scanning = true;
    try {
      const table = await processTable();
      if (this.exited) return;
      const ids = new Set([this.child.pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const entry of table) {
          if (!ids.has(entry.pid) && ids.has(entry.parent)) {
            ids.add(entry.pid);
            changed = true;
          }
        }
      }
      for (const entry of table) if (ids.has(entry.pid)) this.owned.set(entry.pid, entry);
    } catch {
      this.cleanupWarning = "Descendant tracking unavailable; cleanup unconfirmed";
    } finally {
      this.scanning = false;
    }
  }
  async write(chars: string, close: boolean, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.exited || !this.stdinOpen) throw new Error("stdin is closed");
    if (chars) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Input delivery uncertain; do not replay")),
          5000,
        );
        this.child.stdin!.write(chars, "utf8", (error) => {
          clearTimeout(timer);
          error ? reject(new Error("Input delivery uncertain; do not replay")) : resolve();
        });
      });
    }
    if (signal?.aborted) {
      throw new Error(
        "Input cancelled after possible partial delivery; EOF was not sent. Do not replay.",
      );
    }
    if (close) {
      this.stdinOpen = false;
      this.child.stdin!.end();
    }
  }
  interrupt(): void {
    if (this.exited || !this.child.pid) throw new Error("Process is no longer live");
    process.kill(-this.child.pid, "SIGINT");
  }
  cleanupExited(): Promise<void> {
    return (this.finalCleanup ??= (async () => {
      await this.finished;
      // Once the terminal row is retired, shutdown no longer has its process
      // object to revisit. Clean up tracked descendants before returning the
      // final result, even if they closed their inherited output pipes early.
      // Ordinary commands with no tracked descendants need no extra stop wait.
      if ([...this.owned.keys()].some((pid) => pid !== this.child.pid)) await this.stop();
    })());
  }
  async stop(): Promise<string | undefined> {
    if (this.complete && ![...this.owned.keys()].some((pid) => pid !== this.child.pid)) {
      return this.cleanupWarning;
    }
    await this.track();
    const signal = async (name: NodeJS.Signals) => {
      if (!this.exited && this.child.pid) {
        try {
          process.kill(-this.child.pid, name);
        } catch {
          this.cleanupWarning = "Group cleanup unconfirmed";
        }
      }
      try {
        const current = await processTable();
        for (const entry of current) {
          const owned = this.owned.get(entry.pid);
          if (owned && owned.stamp === entry.stamp && entry.pid !== process.pid) {
            try {
              process.kill(entry.pid, name);
            } catch {
              /* Exited between identity check and signal. */
            }
          }
        }
      } catch {
        this.cleanupWarning = "Descendant cleanup unconfirmed";
      }
    };
    await signal("SIGTERM");
    await delay(250);
    await signal("SIGKILL");
    await Promise.race([this.finished, delay(1000)]);
    if (!this.complete) this.cleanupWarning = "Process reap unconfirmed";
    return this.cleanupWarning;
  }
}
