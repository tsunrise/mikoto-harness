import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { z } from "zod";
import { CapabilityRegistry, canonicalRoute } from "./capability-registry.ts";

export const HTTP_LIMITS = Object.freeze({
  headers: 8192,
  body: 16 * 1024,
  response: 100 * 1024 * 1024,
  concurrent: 8,
  connections: 32,
  deadline: 60_000,
});
export type Endpoint = Readonly<{ url: string; port: number; token: string }>;
const Envelope = z.strictObject({
  method: z.enum(["GET", "POST"]),
  path: z.string().refine(canonicalRoute),
  headers: z.record(z.string(), z.string()),
});
const Response = z.strictObject({
  status: z
    .number()
    .int()
    .min(200)
    .max(599)
    .refine((s) => s < 300 || s >= 400),
  body: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
const responseHeaders = new Set(["content-type", "cache-control"]);
class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

function readBody(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = () => {
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("error", error);
      signal.removeEventListener("abort", abort);
    };
    const error = () => {
      cleanup();
      reject(new HttpError(400));
    };
    const abort = () => {
      cleanup();
      req.pause();
      reject(new HttpError(503));
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > HTTP_LIMITS.body) {
        cleanup();
        req.pause();
        reject(new HttpError(413));
        return;
      }
      chunks.push(chunk);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    req.on("data", data);
    req.once("end", end);
    req.once("error", error);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class CapabilityServer {
  private endpointValue: Endpoint | undefined;
  private readonly lifetime = new AbortController();
  private readonly server = createServer({ maxHeaderSize: HTTP_LIMITS.headers }, (req, res) => {
    void this.accept(req, res);
  });
  private active = 0;
  private starting = true;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly headerDeadlines = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
  private readonly registry: CapabilityRegistry;
  private readonly lost: () => void;

  private constructor(registry: CapabilityRegistry, lost: () => void) {
    this.registry = registry;
    this.lost = lost;
    this.server.maxConnections = HTTP_LIMITS.connections;
    this.server.headersTimeout = HTTP_LIMITS.deadline;
    this.server.requestTimeout = HTTP_LIMITS.deadline;
    this.server.keepAliveTimeout = 1000;
    this.server.maxRequestsPerSocket = 16;
    this.server.on("connection", (socket) => {
      const timer = setTimeout(() => socket.destroy(), HTTP_LIMITS.deadline);
      this.headerDeadlines.set(socket, timer);
      socket.once("close", () => clearTimeout(timer));
    });
    this.server.on("connect", (_req, socket) =>
      socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n"),
    );
    this.server.on("upgrade", (_req, socket) =>
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"),
    );
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.on("error", () => {
      if (!this.starting) this.fail();
    });
    this.server.on("close", () => {
      if (!this.closed && !this.starting) this.fail();
    });
  }

  static async start(
    registry: CapabilityRegistry,
    lost: () => void,
  ): Promise<CapabilityServer | undefined> {
    const instance = new CapabilityServer(registry, lost);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Server start timeout")),
          HTTP_LIMITS.deadline,
        );
        const error = () => {
          clearTimeout(timer);
          reject(new Error("Server start failed"));
        };
        instance.server.once("error", error);
        instance.server.listen(0, "127.0.0.1", () => {
          clearTimeout(timer);
          instance.server.removeListener("error", error);
          if (instance.closed) {
            instance.server.close();
            reject(new Error("Server start cancelled"));
            return;
          }
          resolve();
        });
      });
      const address = instance.server.address();
      if (!address || typeof address === "string") throw new Error("No IPv4 endpoint");
      instance.endpointValue = Object.freeze({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        token: randomBytes(32).toString("base64url"),
      });
      instance.starting = false;
      return instance;
    } catch {
      await instance.close();
      return undefined;
    }
  }

  get endpoint(): Endpoint | undefined {
    return this.endpointValue;
  }
  stopAdmitting(): void {
    this.endpointValue = undefined;
    this.lifetime.abort();
  }
  private fail(): void {
    if (this.lifetime.signal.aborted) return;
    this.stopAdmitting();
    this.lost();
  }
  close(): Promise<void> {
    this.closed = true;
    this.stopAdmitting();
    return (this.closePromise ??= new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    }));
  }

  private async accept(req: IncomingMessage, res: ServerResponse): Promise<void> {
    clearTimeout(this.headerDeadlines.get(req.socket));
    req.socket.setTimeout(0);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const reply = (status: number, body = "") => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        connection: "close",
        "cache-control": "no-store",
      });
      res.end(body);
    };
    const timer = setTimeout(() => {
      reply(504, "Request timed out");
      controller.abort();
    }, HTTP_LIMITS.deadline);
    res.once("close", () => controller.abort());
    let admitted = false;
    let removeAbort: (() => void) | undefined;
    try {
      const endpoint = this.endpointValue;
      if (!endpoint) throw new HttpError(503);
      // Check raw duplicates before Node's normalized headers can merge them.
      const seen = new Set<string>();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i].toLowerCase();
        if (seen.has(key)) throw new HttpError(400);
        seen.add(key);
      }
      const auth = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${endpoint.token}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        throw new HttpError(401);
      }
      if (
        req.headers.host !== `127.0.0.1:${endpoint.port}` ||
        !canonicalRoute(req.url ?? "") ||
        req.headers.origin !== undefined ||
        req.headers["content-encoding"] !== undefined ||
        req.headers.expect !== undefined ||
        req.headers.upgrade !== undefined ||
        req.headers["proxy-authorization"] !== undefined ||
        (req.headers["transfer-encoding"] !== undefined &&
          req.headers["transfer-encoding"] !== "chunked") ||
        (req.headers["transfer-encoding"] !== undefined &&
          req.headers["content-length"] !== undefined)
      ) {
        throw new HttpError(400);
      }
      const binding = this.registry.find(req.method ?? "", req.url!);
      if (!binding) throw new HttpError(this.registry.hasPath(req.url!) ? 405 : 404);
      if (this.active >= HTTP_LIMITS.concurrent) throw new HttpError(429);
      this.active++;
      admitted = true;
      const operationSignal = AbortSignal.any([signal, binding.lifetime.signal]);
      const abortRequest = () => reply(503, "Request unavailable");
      operationSignal.addEventListener("abort", abortRequest, { once: true });
      removeAbort = () => operationSignal.removeEventListener("abort", abortRequest);
      const envelope = Envelope.parse({
        method: req.method,
        path: req.url,
        headers: req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {},
      });
      if (Number(req.headers["content-length"]) > HTTP_LIMITS.body) throw new HttpError(413);
      const bytes = await readBody(req, operationSignal);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new HttpError(400);
      }
      let body: unknown;
      if (envelope.method === "GET") {
        if (bytes.length) throw new HttpError(400);
        body = undefined;
      } else if (binding.event.bodyFormat === "text") {
        body = text;
      } else {
        if (
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")
        ) {
          throw new HttpError(415);
        }
        try {
          body = JSON.parse(text);
        } catch {
          throw new HttpError(400);
        }
      }
      operationSignal.throwIfAborted();
      // Keep this request in active until schema/handler work settles, even
      // after its response times out. Otherwise hanging extension code could
      // evade the concurrency bound by accumulating abandoned promises.
      const parsed = await binding.event.bodySchema.safeParseAsync(body);
      operationSignal.throwIfAborted();
      if (!parsed.success) throw new HttpError(400);
      const response = Response.parse(
        await binding.event.handler({
          method: envelope.method,
          path: envelope.path as `/${string}`,
          headers: Object.freeze(envelope.headers),
          body: parsed.data,
          signal: operationSignal,
        }),
      );
      operationSignal.throwIfAborted();
      // The response schema rejects every 3xx status before this point.
      const bodyForbidden = response.status === 204 || response.status === 205;
      if (
        Buffer.byteLength(response.body ?? "") > HTTP_LIMITS.response ||
        (bodyForbidden && response.body)
      ) {
        throw new Error("Invalid response body");
      }
      const headers: Record<string, string> = { "cache-control": "no-store", connection: "close" };
      for (const [key, value] of Object.entries(response.headers ?? {})) {
        if (
          !responseHeaders.has(key) ||
          /[\x00-\x1f\x7f]/.test(value) ||
          Buffer.byteLength(value) > 1024
        ) {
          throw new Error("Invalid response header");
        }
        headers[key] = value;
      }
      res.writeHead(response.status, headers);
      res.end(response.body);
    } catch (error) {
      if (!signal.aborted) {
        reply(error instanceof HttpError ? error.status : 500, "Capability request failed");
      }
    } finally {
      clearTimeout(timer);
      removeAbort?.();
      if (admitted) this.active--;
      controller.abort();
    }
  }
}
