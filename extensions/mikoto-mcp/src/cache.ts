import { mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { digest, readBounded } from "./config.ts";
import { encodeJson, freeze, MiB, snapshotSchema, validateTools, type ServerSnapshot } from "./schema.ts";

export class Cache {
  private writes = new Map<string, Promise<void>>();
  readonly directory: string;
  private warn: (server: string, reason: string) => void;
  constructor(directory: string, warn: (server: string, reason: string) => void) {
    this.directory = directory; this.warn = warn;
  }
  path(server: string) { return join(this.directory, `${digest(server)}.json`); }
  async read(server: string, fingerprint: string): Promise<ServerSnapshot | undefined> {
    try {
      const snapshot = snapshotSchema.parse(JSON.parse(await readBounded(this.path(server), 16 * MiB)));
      if (snapshot.server !== server) throw new Error("identity");
      snapshot.tools = validateTools(snapshot.tools);
      if (snapshot.configFingerprint !== fingerprint) return undefined;
      return freeze(snapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn(server, "cache_unavailable");
      return undefined;
    }
  }
  write(snapshot: ServerSnapshot, signal: AbortSignal): Promise<void> {
    const previous = this.writes.get(snapshot.server) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      const data = encodeJson(snapshot, 16 * MiB);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temp = join(this.directory, `.${digest(snapshot.server)}.${randomUUID()}.tmp`);
      try {
        const handle = await open(temp, "wx", 0o600);
        try { await handle.writeFile(data); } finally { await handle.close(); }
        signal.throwIfAborted();
        await rename(temp, this.path(snapshot.server));
      } finally { await unlink(temp).catch(() => {}); }
    });
    this.writes.set(snapshot.server, next);
    return next;
  }
  async settled() { await Promise.allSettled(this.writes.values()); }
}
