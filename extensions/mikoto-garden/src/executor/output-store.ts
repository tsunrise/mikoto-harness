import { openSync, writeSync, closeSync, unlinkSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";

export const OUTPUT_LIMITS = Object.freeze({
  preview: 4096,
  unread: 1024 * 1024,
  log: 32 * 1024 * 1024,
  runtime: 256 * 1024 * 1024,
});
export type LogQuota = { bytes: number };
type OutputReservation = {
  id: string;
  version: number;
  retainedBytes: number;
  trimVersion: number;
  omitted: number;
  preserveLog: boolean;
};
const RETAINED_SIDE = OUTPUT_LIMITS.unread / 2;
const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

export function sanitize(text: string): string {
  // Scan OSC delimiters once. A regex that searches for a terminator from
  // every ESC ] can stall the executor on a truncated, control-heavy log.
  // Stop at the first terminator so OSC 8 hyperlinks keep their visible label.
  const parts: string[] = [];
  let start = -1;
  let keptFrom = 0;
  for (const match of text.matchAll(/\x1b\]|\x07|\x1b\\/g)) {
    if (match[0] === "\x1b]") {
      if (start < 0) start = match.index;
    } else if (start >= 0) {
      parts.push(text.slice(keptFrom, start));
      keptFrom = match.index + match[0].length;
      start = -1;
    }
  }
  // Incomplete sequences remain ordinary text, with controls stripped below.
  parts.push(text.slice(keptFrom));
  return parts.join("")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
export function boundedText(text: string, bytes: number, lines = 2000): string {
  if (bytes <= 0 || lines <= 0) return "";
  const buffer = Buffer.from(text);
  const end = Math.min(bytes, buffer.length);
  let safeEnd = end;
  while (safeEnd > 0 && safeEnd < buffer.length && (buffer[safeEnd] & 0xc0) === 0x80) safeEnd--;
  const cut = buffer.subarray(0, safeEnd).toString("utf8");
  let count = 0;
  for (let i = 0; i < cut.length; i++) {
    if (cut[i] === "\n" && ++count >= lines) return cut.slice(0, i);
  }
  return cut;
}
export class OutputStore {
  private readonly decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
  // Once unread output fills the budget, retain its first and last halves.
  // Chunks enter this structure once, and the tail advances like a deque, so a
  // sustained flood does not repeatedly scan and rebuild the entire 1 MiB
  // window for every pipe chunk.
  private head: Buffer[] = [];
  private headBytes = 0;
  private headSealed = false;
  private tail: Buffer[] = [];
  private tailStart = 0;
  private tailBytes = 0;
  private previewTail = "";
  private omitted = 0;
  private version = 0;
  private trimVersion = 0;
  private logBytes = 0;
  private fd: number | undefined;
  private capped = false;
  private preserveLog = false;
  private pending: OutputReservation | undefined;
  readonly log: string;
  private readonly quota: LogQuota;
  constructor(log: string, quota: LogQuota) {
    this.log = log;
    this.quota = quota;
    this.fd = openSync(log, "wx", 0o600);
  }
  append(chunk: Buffer, stream: number): void {
    // Synchronous bounded writes avoid an unbounded log-write promise queue.
    // Once quota/disk availability is exhausted we still drain both pipes.
    if (this.fd !== undefined) {
      const length = Math.min(
        chunk.length,
        OUTPUT_LIMITS.log - this.logBytes,
        OUTPUT_LIMITS.runtime - this.quota.bytes,
      );
      try {
        if (length > 0) {
          const written = writeSync(this.fd, chunk, 0, length);
          this.logBytes += written;
          this.quota.bytes += written;
          if (written !== length) this.capped = true;
        }
        if (length !== chunk.length) this.capped = true;
      } catch {
        this.capped = true;
        closeSync(this.fd);
        this.fd = undefined;
      }
    }
    this.add(this.decoders[stream].write(chunk));
  }
  private add(text: string): void {
    // The local process browser needs a useful tail after the agent collects
    // output too. Keep a separate small arrival-ordered tail; acknowledging a
    // delivery consumes unread output, never this read-only preview.
    if (text) {
      const bytes = Buffer.from(text);
      const recent =
        bytes.length >= OUTPUT_LIMITS.preview
          ? bytes
          : Buffer.concat([Buffer.from(this.previewTail), bytes]);
      let start = Math.max(0, recent.length - OUTPUT_LIMITS.preview);
      while (start < recent.length && (recent[start] & 0xc0) === 0x80) start++;
      this.previewTail = recent.subarray(start).toString("utf8");
      this.retain(bytes);
    }
    this.version++;
  }
  private retain(bytes: Buffer): void {
    let offset = 0;
    if (!this.headSealed) {
      const available = RETAINED_SIDE - this.headBytes;
      let end = Math.min(bytes.length, available);
      if (end < bytes.length) {
        while (end > 0 && isContinuation(bytes[end])) end--;
      }
      if (end > 0) {
        this.head.push(
          end === bytes.length ? bytes : Buffer.from(bytes.subarray(0, end)),
        );
        this.headBytes += end;
        offset = end;
      }
      if (offset < bytes.length || this.headBytes === RETAINED_SIDE) {
        this.headSealed = true;
      }
    }
    if (offset < bytes.length) this.appendTail(bytes.subarray(offset));
  }
  private appendTail(bytes: Buffer): void {
    const limit = OUTPUT_LIMITS.unread - this.headBytes;
    if (bytes.length >= limit) {
      let start = bytes.length - limit;
      while (start < bytes.length && isContinuation(bytes[start])) start++;
      const dropped = this.tailBytes + start;
      this.tail = [Buffer.from(bytes.subarray(start))];
      this.tailStart = 0;
      this.tailBytes = bytes.length - start;
      if (dropped > 0) {
        this.omitted += dropped;
        this.trimVersion++;
      }
      return;
    }
    this.tail.push(bytes);
    this.tailBytes += bytes.length;
    const excess = this.tailBytes - limit;
    if (excess <= 0) return;
    this.omitted += this.dropTailPrefix(excess);
    this.trimVersion++;
  }
  private dropTailPrefix(bytes: number): number {
    let remaining = bytes;
    let dropped = 0;
    while (remaining > 0) {
      const chunk = this.tail[this.tailStart]!;
      if (chunk.length <= remaining) {
        dropped += chunk.length;
        remaining -= chunk.length;
        this.tailBytes -= chunk.length;
        this.tailStart++;
        continue;
      }
      let start = remaining;
      while (start < chunk.length && isContinuation(chunk[start])) start++;
      this.tail[this.tailStart] = chunk.subarray(start);
      dropped += start;
      this.tailBytes -= start;
      remaining = 0;
    }
    // Advancing an index makes each discarded chunk O(1). Compact
    // occasionally so the backing array also remains bounded over floods.
    if (this.tailStart > 0 && this.tailStart * 2 >= this.tail.length) {
      this.tail = this.tail.slice(this.tailStart);
      this.tailStart = 0;
    }
    return dropped;
  }
  private retainedChunks(): Buffer[] {
    return [...this.head, ...this.tail.slice(this.tailStart)];
  }
  private retainedText(): string {
    return Buffer.concat(this.retainedChunks(), this.retainedBytes).toString("utf8");
  }
  private retainedSuffix(bytes: number): Buffer[] {
    const chunks: Buffer[] = [];
    let remaining = bytes;
    for (const chunk of this.retainedChunks()) {
      if (remaining >= chunk.length) {
        remaining -= chunk.length;
      } else {
        chunks.push(remaining > 0 ? chunk.subarray(remaining) : chunk);
        remaining = 0;
      }
    }
    return chunks;
  }
  private resetRetained(): void {
    this.head = [];
    this.headBytes = 0;
    this.headSealed = false;
    this.tail = [];
    this.tailStart = 0;
    this.tailBytes = 0;
  }
  private get retainedBytes(): number {
    return this.headBytes + this.tailBytes;
  }
  close(): void {
    for (const decoder of this.decoders) this.add(decoder.end());
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }
  get unread(): number {
    return this.retainedBytes + this.omitted;
  }
  preview(): string {
    return sanitize(this.previewTail);
  }
  reserve(tokens: number) {
    if (this.pending) throw new Error("Output handoff already reserved");
    const id = randomUUID().slice(0, 8);
    const buffer = this.retainedText();
    const output = boundedText(sanitize(buffer), Math.min(44 * 1024, tokens * 4));
    const omitted =
      this.omitted + Math.max(0, this.retainedBytes - Buffer.byteLength(output));
    this.pending = {
      id,
      version: this.version,
      retainedBytes: this.retainedBytes,
      trimVersion: this.trimVersion,
      omitted: this.omitted,
      preserveLog: omitted > 0 || this.capped,
    };
    return { chunk: id, output, omitted, log: this.log, logCapped: this.capped };
  }
  ack(id: string, preserveLog = false): void {
    const pending = this.pending;
    if (!pending || pending.id !== id) throw new Error("Unknown output reservation");
    // Formatting the complete response can introduce additional omissions.
    // The adapter tells us when it exposed a log for that reason as well.
    this.preserveLog ||= pending.preserveLog || preserveLog;
    if (this.version === pending.version) {
      this.resetRetained();
      this.omitted = 0;
    } else if (this.trimVersion === pending.trimVersion) {
      const remaining = this.retainedSuffix(pending.retainedBytes);
      this.resetRetained();
      this.omitted = Math.max(0, this.omitted - pending.omitted);
      for (const chunk of remaining) this.retain(chunk);
    }
    // If a flood reshaped the bounded head/tail while delivery was pending,
    // retaining some duplicate bytes is safer than dropping undisclosed output.
    this.pending = undefined;
  }
  release(): void {
    this.pending = undefined;
  }
  discardUnreferencedLog(): void {
    if (this.fd !== undefined || this.pending || this.preserveLog || this.unread) return;
    try {
      unlinkSync(this.log);
      // The quota bounds retained log bytes, not cumulative traffic over an
      // arbitrarily long session. Ordinary fully observed commands free it.
      this.quota.bytes -= this.logBytes;
      this.logBytes = 0;
    } catch {
      /* Generation teardown will retry owned runtime cleanup. */
    }
  }
}
