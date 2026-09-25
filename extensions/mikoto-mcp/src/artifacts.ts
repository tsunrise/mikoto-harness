import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "./errors.ts";
import { encodeJson, MiB } from "./schema.ts";

export type FileReference = { path: string; mimeType: string; bytes: number; lifetime: "runtime" };
export type ArtifactRefContent = {
  type: "artifact_ref"; kind: "image" | "audio" | "resource"; file: FileReference;
  imageReadable: boolean; detectedImageMimeType?: string; sourceUri?: string;
  annotations?: object; _meta?: object;
};
export const defaultLimits = {
  bytes: 512 * MiB, files: 1024, wire: 64 * MiB, decoded: 32 * MiB, blocks: 32, report: 16 * MiB,
};
type Limits = typeof defaultLimits;
type Root = { path: string; ino: number; dev: number };
const extensions: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
  "image/bmp": ".bmp", "audio/wav": ".wav", "audio/mpeg": ".mp3", "audio/ogg": ".ogg",
  "application/json": ".json", "application/pdf": ".pdf",
};

export function base64Bytes(data: string): number {
  let length = data.length;
  while (length && data[length - 1] === "=") length--;
  const padding = data.length - length;
  if (length % 4 === 1 || padding > 2 || (padding && (data.length % 4 !== 0 || padding !== (4 - length % 4))))
    throw new McpError("invalid_result");
  for (let i = 0; i < length; i++) {
    const c = data.charCodeAt(i);
    if (!(c >= 65 && c <= 90) && !(c >= 97 && c <= 122) && !(c >= 48 && c <= 57) && c !== 43 && c !== 47)
      throw new McpError("invalid_result");
  }
  // Reject nonzero pad bits too: Node's decoder otherwise silently discards them.
  const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(data[length - 1] ?? "A");
  if ((length % 4 === 2 && (last & 15)) || (length % 4 === 3 && (last & 3)))
    throw new McpError("invalid_result");
  return Math.floor(length * 6 / 8);
}

export class Reservation {
  private done = false;
  private store: ArtifactStore;
  readonly bytes: number;
  readonly files: number;
  constructor(store: ArtifactStore, bytes: number, files: number) {
    this.store = store; this.bytes = bytes; this.files = files;
  }
  finish(bytes = 0, files = 0) {
    if (this.done) return;
    this.done = true;
    this.store.release(this.bytes - bytes, this.files - files);
  }
}

export class ArtifactStore {
  readonly limits: Limits;
  private root?: Promise<Root>;
  private usedBytes = 0;
  private usedFiles = 0;
  private counter = 0;
  private writers = new Set<Promise<unknown>>();
  private stopped = false;
  private closing?: Promise<void>;
  private lifetime: AbortSignal;
  private warn: (reason: string) => void;
  constructor(
    lifetime: AbortSignal,
    warn: (reason: string) => void,
    limits: Partial<Limits> = {},
  ) { this.lifetime = lifetime; this.warn = warn; this.limits = { ...defaultLimits, ...limits }; }

  reserve(bytes = this.limits.wire + this.limits.decoded, files = this.limits.blocks + 1) {
    this.lifetime.throwIfAborted();
    if (this.stopped || this.usedBytes + bytes > this.limits.bytes || this.usedFiles + files > this.limits.files)
      throw new McpError("artifact_capacity");
    this.usedBytes += bytes; this.usedFiles += files;
    return new Reservation(this, bytes, files);
  }
  release(bytes: number, files: number) { this.usedBytes -= bytes; this.usedFiles -= files; }
  private getRoot() {
    return this.root ??= (async () => {
      const path = await realpath(await mkdtemp(join(tmpdir(), "mikoto-mcp-")));
      await chmod(path, 0o700);
      const info = await lstat(path);
      return { path, ino: info.ino, dev: info.dev };
    })();
  }
  private async checkRoot(root: Root) {
    const info = await lstat(root.path);
    if (!info.isDirectory() || info.ino !== root.ino || info.dev !== root.dev
      || await realpath(root.path) !== root.path) throw new Error("identity");
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new McpError("artifact_write_failed"));
    const promise = work();
    this.writers.add(promise);
    void promise.then(() => this.writers.delete(promise), () => this.writers.delete(promise));
    return promise;
  }
  private transaction<T>(
    reservation: Reservation, signal: AbortSignal,
    work: (write: (name: string, mime: string, data: string | Buffer) => Promise<FileReference>) => Promise<T>,
  ): Promise<T> {
    return this.track(async () => {
      let root: Root | undefined;
      let dir: string | undefined;
      let published = false;
      let bytes = 0, files = 0;
      const check = () => { signal.throwIfAborted(); this.lifetime.throwIfAborted(); };
      try {
        check();
        root = await this.getRoot();
        check();
        await this.checkRoot(root);
        dir = join(root.path, `output-${++this.counter}`);
        await mkdir(dir, { mode: 0o700 });
        const value = await work(async (name, mimeType, data) => {
          check();
          const size = Buffer.byteLength(data);
          if (bytes + size > reservation.bytes || files + 1 > reservation.files) throw new McpError("result_too_large");
          const path = join(dir!, name);
          await writeFile(path, data, { flag: "wx", mode: 0o600, signal });
          check();
          bytes += size; files++;
          return { path, mimeType, bytes: size, lifetime: "runtime" };
        });
        check();
        published = true;
        reservation.finish(bytes, files);
        return value;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (this.lifetime.aborted) throw this.lifetime.reason;
        throw error instanceof McpError ? error : new McpError("artifact_write_failed");
      } finally {
        if (!published) {
          let removed = true;
          if (dir && root) {
            try { await this.checkRoot(root); await rm(dir, { recursive: true, force: true }); }
            catch { removed = false; this.warn("artifact_cleanup_failed"); }
          }
          // If partial output could not be removed, keep its worst-case quota
          // charged. Otherwise repeated failed deliveries could fill the disk
          // while our logical accounting claimed every byte was free.
          reservation.finish(removed ? 0 : reservation.bytes, removed ? 0 : reservation.files);
        }
      }
    });
  }

  report(json: string, signal: AbortSignal): Promise<FileReference> {
    const bytes = Buffer.byteLength(json);
    if (bytes > this.limits.report) throw new McpError("search_result_too_large");
    const reservation = this.reserve(bytes, 1);
    return this.transaction(reservation, signal, write => write("search.json", "application/json", json));
  }

  prepare(result: CallToolResult) {
    const json = encodeJson(result, this.limits.wire);
    const media: { index: number; data: string; mime: string; kind: ArtifactRefContent["kind"]; uri?: string }[] = [];
    let decoded = 0;
    for (const [index, block] of result.content.entries()) {
      if (block.type === "image" || block.type === "audio")
        media.push({ index, data: block.data, mime: block.mimeType, kind: block.type });
      else if (block.type === "resource" && "blob" in block.resource)
        media.push({ index, data: block.resource.blob, mime: block.resource.mimeType ?? "application/octet-stream",
          kind: "resource", uri: block.resource.uri });
    }
    if (media.length > this.limits.blocks) throw new McpError("result_too_large");
    for (const item of media) {
      decoded += base64Bytes(item.data);
      if (decoded > this.limits.decoded) throw new McpError("result_too_large");
    }
    return { json, media };
  }

  async project(result: CallToolResult, reservation: Reservation, signal: AbortSignal, prepared = this.prepare(result)) {
    const { json, media } = prepared;
    if (!media.length) { signal.throwIfAborted(); reservation.finish(); return { result, rawResult: undefined }; }
    return this.transaction(reservation, signal, async write => {
      const rawResult = await write("result.json", "application/json", json);
      const content: (CallToolResult["content"][number] | ArtifactRefContent)[] = [...result.content];
      for (const [counter, item] of media.entries()) {
        signal.throwIfAborted();
        const extension = Object.hasOwn(extensions, item.mime) ? extensions[item.mime] : ".bin";
        const file = await write(`media-${counter}${extension}`, item.mime, Buffer.from(item.data, "base64"));
        const detected = await detectSupportedImageMimeTypeFromFile(file.path);
        const block = result.content[item.index];
        content[item.index] = {
          type: "artifact_ref", kind: item.kind, file, imageReadable: detected !== null,
          ...(detected ? { detectedImageMimeType: detected } : {}),
          ...(item.uri === undefined ? {} : { sourceUri: item.uri }),
          ...(block.annotations ? { annotations: block.annotations } : {}),
          ...(block._meta ? { _meta: block._meta } : {}),
        };
      }
      return { result: { ...result, content }, rawResult };
    });
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.stopped = true;
      await Promise.allSettled(this.writers);
      if (!this.root) return;
      try {
        const root = await this.root;
        await this.checkRoot(root);
        await rm(root.path, { recursive: true, force: true });
      } catch { this.warn("artifact_cleanup_failed"); }
    })();
  }
}
