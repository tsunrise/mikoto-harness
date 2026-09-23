import net from "node:net";
import {
  DEADLINE_MS, JsonLine, RESPONSE_BYTES, validPath, validateResponse,
  type Command, type Response,
} from "./protocol.ts";

export class ContextError extends Error {
  readonly kind: "unavailable" | "malformed" | "aborted";
  constructor(kind: ContextError["kind"]) {
    super(kind);
    this.kind = kind;
  }
}

export function endpointFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | undefined {
  const endpoint = env.MIKOTO_VSCODE_CONTEXT_SOCKET;
  return ["darwin", "linux"].includes(platform) && validPath(endpoint, 100) ? endpoint : undefined;
}

export function request(
  endpoint: string,
  command: Command,
  signal?: AbortSignal,
  timeoutMs = DEADLINE_MS,
): Promise<Response> {
  if (!validPath(endpoint, 100)) return Promise.reject(new ContextError("unavailable"));
  if (signal?.aborted) return Promise.reject(new ContextError("aborted"));
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const frame = new JsonLine(RESPONSE_BYTES);
    let settled = false;
    const finish = (error?: ContextError, response?: Response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.removeAllListeners();
      // destroy normally has no error, but an already queued OS error must not
      // become an uncaught event after we've removed the request handlers.
      socket.on("error", () => {});
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const abort = () => finish(new ContextError("aborted"));
    const timer = setTimeout(() => finish(new ContextError("unavailable")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", () => finish(new ContextError("unavailable")));
    socket.on("end", () => finish(new ContextError("malformed")));
    socket.on("close", () => finish(new ContextError("unavailable")));
    socket.on("data", chunk => {
      try {
        const line = frame.push(chunk);
        if (line) finish(undefined, validateResponse(line.value, command));
      } catch {
        finish(new ContextError("malformed"));
      }
    });
    socket.once("connect", () => socket.write(JSON.stringify({ version: 1, command }) + "\n"));
    try { socket.connect(endpoint); } catch { finish(new ContextError("unavailable")); }
  });
}
