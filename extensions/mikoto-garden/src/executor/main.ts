import { mkdir, mkdtemp, realpath, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  boundedMessage,
  CONTRACT,
  operationDigest,
  type Request,
  type Requests,
  type Responses,
  type WireResponse,
} from "../protocol.ts";
import { Sandbox } from "./sandbox.ts";
import { TerminalManager } from "./terminal-manager.ts";
import { sanitize } from "./output-store.ts";
import { cleanupOwnedRuntimeRoot } from "./runtime-root.ts";

let generation: string | undefined;
let highWater = 0;
let sandbox: Sandbox | undefined;
let manager: TerminalManager | undefined;
let root: string | undefined;
let rootInode: number | undefined;
let ready = false;
let capabilities = false;
let closing: Promise<{ warnings: string[] }> | undefined;
let initializing: Promise<unknown> | undefined;
const operations = new Map<number, AbortController>();
const launches = new Set<number>();
let queuedBytes = 0;
function send(message: WireResponse): void {
  if (!process.connected) return;
  const bytes = Buffer.byteLength(JSON.stringify(message));
  if ("event" in message && message.event === "progress" && queuedBytes + bytes > 1024 * 1024) {
    return;
  }
  if (!boundedMessage(message) || queuedBytes + bytes > 8 * 1024 * 1024) {
    // Don't let a stopped parent turn progress/results into an unbounded IPC
    // queue. Mutation delivery is now uncertain; disconnect, never replay.
    process.disconnect?.();
    void shutdown();
    return;
  }
  queuedBytes += bytes;
  process.send?.(message, (error) => {
    queuedBytes -= bytes;
    if (error && process.connected) process.disconnect?.();
  });
}
async function shutdown(): Promise<{ warnings: string[] }> {
  return (closing ??= (async () => {
    ready = false;
    for (const controller of operations.values()) controller.abort();
    // Initialization may still be creating the owned root or SRT listeners.
    // Don't finish cleanup before that work has stopped acquiring resources.
    await initializing?.catch(() => {});
    const result = (await manager?.close()) ?? { warnings: [] };
    await sandbox?.close().catch(() => result.warnings.push("SRT cleanup unconfirmed"));
    if (root) await cleanupOwnedRuntimeRoot(root, rootInode, result.warnings);
    return result;
  })());
}
async function dispatch(request: Request): Promise<Responses[keyof Responses]> {
  const signal = operations.get(request.id)!.signal;
  if (request.method === "init") {
    // The first initialization awaits filesystem work before assigning
    // sandbox. Its promise closes that gap and also prevents retrying a
    // partially failed setup in the same disposable executor.
    if (initializing || sandbox || closing) {
      throw new Error("Executor already initialized or closing");
    }
    const data = request.data as Requests["init"];
    if (
      data.contract !== CONTRACT ||
      !data.policy?.network ||
      process.platform !== "darwin" ||
      Number(process.versions.node.split(".")[0]) < 26
    ) {
      throw new Error("Unsupported command execution runtime");
    }
    root = await mkdtemp(join(await realpath(data.runtimeParent), "mikoto-garden-"));
    rootInode = (await lstat(root)).ino;
    const control = join(root, "control");
    const scratch = join(root, "scratch");
    await mkdir(control, { mode: 0o700 });
    await mkdir(scratch, { mode: 0o700 });
    sandbox = new Sandbox(data.policy, control, scratch, data.endpoint);
    const diagnostics = await sandbox.initialize();
    signal.throwIfAborted();
    manager = new TerminalManager(
      sandbox,
      control,
      scratch,
      (job) => send({ generation: generation!, event: "exit", job }),
      (id, delivery) => send({ generation: generation!, event: "progress", id, delivery }),
    );
    capabilities = !!data.endpoint;
    ready = true;
    return { diagnostics };
  }
  if (request.method === "shutdown") return shutdown();
  if (!ready || !manager || !sandbox) throw new Error("Command executor unavailable");
  if (request.method === "preflight") {
    await sandbox.checkReady();
    return null;
  }
  if (request.method === "revoke") {
    sandbox.revoke();
    capabilities = false;
    return null;
  }
  if (request.method === "cancel") {
    const { request: id } = request.data as Requests["cancel"];
    operations.get(id)?.abort();
    await manager.cancel(id);
    return null;
  }
  let requiresApproval = false;
  if (request.method === "spawn") {
    requiresApproval = (request.data as Requests["spawn"]).launch.mode === "unsandboxed";
  } else if (request.method === "input") {
    const data = request.data as Requests["input"];
    if (data.operation.kind !== "poll") {
      requiresApproval = manager.list(data.id).jobs[0].mode === "unsandboxed";
    }
  }
  if (
    requiresApproval &&
    (!request.approval ||
      request.approval.generation !== generation ||
      request.approval.operation !== request.id ||
      request.approval.digest !== operationDigest(request.data))
  ) {
    throw new Error("Missing operation-bound internal authorization");
  }
  switch (request.method) {
    case "spawn": {
      const data = request.data as Requests["spawn"];
      if (!["sandboxed", "unsandboxed"].includes(data.launch.mode)) {
        throw new Error("Invalid launch mode");
      }
      if (data.launch.capabilities !== capabilities) {
        throw new Error("Capability availability changed before spawn");
      }
      return manager.spawn(data, request.id, signal, () => {
        if (data.launch.capabilities !== capabilities) {
          throw new Error("Capability availability changed before spawn");
        }
      });
    }
    case "input":
      return manager.input(request.data as Requests["input"], request.id, signal, capabilities);
    case "ack": {
      const data = request.data as Requests["ack"];
      manager.ack(data.id, data.chunk, data.preserveLog);
      return null;
    }
    case "list":
      return manager.list((request.data as Requests["list"]).id);
    case "stop": {
      const data = request.data as Requests["stop"];
      if (data.all) for (const id of launches) operations.get(id)?.abort();
      return manager.stop(data.id, data.all);
    }
    default:
      throw new Error("Unknown executor operation");
  }
}
process.on("message", (raw: unknown) => {
  if (!boundedMessage(raw)) {
    void shutdown().finally(() => process.exit(1));
    return;
  }
  const request = raw as Request;
  if (
    typeof request.generation !== "string" ||
    !Number.isSafeInteger(request.id) ||
    request.id <= highWater ||
    !request.data ||
    operations.size >= 256 ||
    (generation !== undefined && request.generation !== generation)
  ) {
    void shutdown().finally(() => process.exit(1));
    return;
  }
  generation ??= request.generation;
  highWater = request.id;
  operations.set(request.id, new AbortController());
  if (request.method === "spawn") launches.add(request.id);
  const operation = dispatch(request);
  // A rejected duplicate must not replace the first promise: shutdown still
  // has to wait for that original setup to stop acquiring runtime resources.
  if (request.method === "init") initializing ??= operation;
  void operation
    .then(
      (result) => send({ generation: generation!, id: request.id, result }),
      (error: unknown) =>
        send({
          generation: generation!,
          id: request.id,
          error: sanitize(error instanceof Error ? error.message : "Executor failure").slice(
            0,
            1000,
          ),
        }),
    )
    .finally(() => {
      operations.delete(request.id);
      launches.delete(request.id);
      if (request.method === "shutdown") process.disconnect?.();
    });
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    void shutdown().finally(() => process.exit());
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
process.on("disconnect", () => {
  void shutdown().finally(() => process.exit());
  setTimeout(() => process.exit(1), 5000).unref();
});
