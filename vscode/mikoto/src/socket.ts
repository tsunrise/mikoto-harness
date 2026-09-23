import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, rmdir, unlink } from "node:fs/promises";
import {
  contextResponse, DEADLINE_MS, JsonLine, REQUEST_BYTES, validateRequest, validateSnapshot,
  type Snapshot,
} from "./protocol";

export type ContextServer = { socketPath: string; dispose(): Promise<void> };
type Options = { temporaryRoot?: string; onFailure?: () => void; deadlineMs?: number };

export async function createContextServer(
  capture: () => Snapshot | undefined,
  options: Options = {},
): Promise<ContextServer> {
  let directory: string | undefined;
  let socketPath = "";
  let bound = false;
  let ready = false;
  let disposing: Promise<void> | undefined;
  const clients = new Set<net.Socket>();
  const server = net.createServer(client => {
    if (clients.size >= 16 || disposing) { client.destroy(); return; }
    clients.add(client);
    const deadline = setTimeout(() => client.destroy(), options.deadlineMs ?? DEADLINE_MS);
    const frame = new JsonLine(REQUEST_BYTES);
    let dispatched = false;
    client.on("error", () => client.destroy());
    client.on("close", () => { clearTimeout(deadline); clients.delete(client); });
    client.on("end", () => { if (!dispatched) client.destroy(); });
    client.on("data", chunk => {
      if (dispatched) return;
      try {
        const line = frame.push(chunk);
        if (!line) return;
        dispatched = true;
        const command = validateRequest(line.value);
        if (command === "ping") {
          client.end('{"version":1,"status":"ok"}\n');
        } else {
          const snapshot = capture();
          client.end(snapshot ? contextResponse(validateSnapshot(snapshot)) : '{"version":1,"status":"empty"}\n');
        }
      } catch {
        dispatched = true;
        client.end('{"version":1,"status":"error","message":"Invalid request or capture"}\n');
      }
    });
  });
  const dispose = (): Promise<void> => disposing ??= (async () => {
    ready = false;
    for (const client of clients) client.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (bound) await unlink(socketPath).catch(ignoreMissing);
    if (directory) await rmdir(directory).catch(ignoreMissing);
  })();
  server.on("error", () => {
    if (ready) {
      ready = false;
      options.onFailure?.();
      void dispose().catch(() => {});
    }
  });
  try {
    for (const root of [...new Set([options.temporaryRoot ?? os.tmpdir(), "/tmp"])]) {
      directory = await mkdtemp(path.join(root, "mikoto-vsc-"));
      await chmod(directory, 0o700);
      socketPath = path.join(directory, "context.sock");
      if (Buffer.byteLength(socketPath) <= 100) break;
      await rmdir(directory);
      directory = undefined;
    }
    if (!directory) throw new Error("Socket path too long");
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once("error", failed);
      server.listen(socketPath, () => {
        server.off("error", failed);
        bound = true;
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
    ready = true;
    return { socketPath, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function ignoreMissing(error: NodeJS.ErrnoException) {
  if (error.code !== "ENOENT") throw error;
}
