import { spawn } from "node:child_process";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { MikotoPolicyDocument } from "mikoto-types";
import { innerPayload, type Launch } from "../launch.ts";
import { checkPolicyPaths, compilePolicy } from "./policy-compiler.ts";
import { evaluateDestination } from "./network-policy.ts";

export class Sandbox {
  private queue: Promise<unknown> = Promise.resolve();
  private alive = false;
  private closed = false;
  private endpoint: { port: number } | undefined;
  private readonly policy: MikotoPolicyDocument;
  private readonly control: string;
  private readonly scratch: string;
  constructor(
    policy: MikotoPolicyDocument,
    control: string,
    scratch: string,
    endpoint?: { port: number },
  ) {
    this.endpoint = endpoint;
    this.policy = policy;
    this.control = control;
    this.scratch = scratch;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  initialize(): Promise<string[]> {
    return this.serial(async () => {
      if (this.closed) throw new Error("Sandbox generation closed");
      const compiled = await compilePolicy(this.policy, this.control, this.scratch);
      process.env.CLAUDE_CODE_TMPDIR = this.scratch;
      await SandboxManager.initialize(
        {
          filesystem: compiled.filesystem,
          network: {
            allowedDomains: [],
            deniedDomains: [],
            strictAllowlist: false,
            allowAllUnixSockets: false,
            allowLocalBinding: false,
          },
          // Go's macOS TLS verification needs trustd.agent. This widens the
          // Mach service boundary, not the destination policy enforced below.
          enableWeakerNetworkIsolation: true,
        },
        async ({ host, port }) =>
          typeof port === "number" &&
          evaluateDestination(this.policy.network, this.endpoint, host, port, this.alive),
        false,
      );
      if (this.closed) throw new Error("Sandbox initialization cancelled");
      this.alive = true;
      try {
        const wrapped = await SandboxManager.wrapWithSandboxArgv("exec /usr/bin/true", "/bin/sh");
        if (!wrapped.argv.join(" ").includes("/usr/bin/sandbox-exec")) {
          throw new Error("OS sandbox wrapper unavailable");
        }
        await new Promise<void>((resolve, reject) => {
          const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
            stdio: "ignore",
            env: process.env,
          });
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("Sandbox probe timed out"));
          }, 5000);
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            code === 0 ? resolve() : reject(new Error("Sandbox probe failed"));
          });
        });
      } finally {
        SandboxManager.cleanupAfterCommand();
      }
      return compiled.diagnostics;
    });
  }
  revoke(): void {
    this.endpoint = undefined;
  }
  async checkReady(): Promise<void> {
    if (!this.alive) throw new Error("Sandbox unavailable");
    await checkPolicyPaths(this.policy);
  }
  wrap(launch: Launch): Promise<{ argv: string[]; cleanup: () => Promise<void> }> {
    return this.serial(async () => {
      await this.checkReady();
      const cwd = process.cwd();
      try {
        // The pinned Unix API ignores cwd. Only this isolated executor changes
        // cwd, and all storage paths elsewhere in the executor are absolute.
        process.chdir(launch.cwd);
        // `/bin/sh` interprets only our quoted bootstrap payload. That payload
        // then execs launch.shell, so the selected shell interprets the actual
        // command and applies the requested login behavior.
        const wrapped = await SandboxManager.wrapWithSandboxArgv(
          innerPayload(launch, this.scratch),
          "/bin/sh",
        );
        if (!wrapped.argv.join(" ").includes("/usr/bin/sandbox-exec")) {
          throw new Error("OS sandbox wrapper unavailable");
        }
        let released = false;
        return {
          argv: wrapped.argv,
          cleanup: () =>
            this.serial(async () => {
              if (!released) {
                released = true;
                SandboxManager.cleanupAfterCommand();
              }
            }),
        };
      } finally {
        process.chdir(cwd);
      }
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.alive = false;
    await this.serial(() => SandboxManager.reset());
  }
}
