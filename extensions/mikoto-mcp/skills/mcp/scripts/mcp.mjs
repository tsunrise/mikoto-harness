import { mkdtemp, writeFile } from "node:fs/promises";
import { setGlobalProxyFromEnv } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REQUEST_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 100 * 1024 * 1024;
// Keep printed output below exec_command's 50 KiB cap. Larger output still
// prints, but the saved response path is announced first.
const INLINE_LIMIT = 32 * 1024;
const USAGE = "Usage: node mcp.mjs SERVER TOOL ['<arguments JSON object>' | -]";
class SafeError extends Error {}

async function readBounded(stream, limit, signal) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  let cancellation;
  const cancel = () => { cancellation ??= reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new SafeError("Response exceeds the 100 MiB limit.");
      chunks.push(value);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
    } catch {
      throw new SafeError("Invalid UTF-8 response.");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    await cancellation;
    reader.releaseLock();
  }
}

async function readStdin(signal) {
  const chunks = [];
  let size = 0;
  const abort = () => process.stdin.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of process.stdin) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > REQUEST_LIMIT) throw new SafeError("Request exceeds 16 KiB.");
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
    } catch {
      throw new SafeError("Invalid UTF-8 input.");
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function request(argv, signal) {
  if (argv.length < 2 || argv.length > 3 || !argv[0] || !argv[1]) throw new SafeError(USAGE);
  const [server, name, raw = "{}"] = argv;
  const text = raw === "-" ? await readStdin(signal) : raw;
  let args;
  try { args = JSON.parse(text); } catch { throw new SafeError("Arguments are not valid JSON."); }
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new SafeError("Arguments must be a JSON object.");
  const body = JSON.stringify({ server, name, arguments: args });
  if (Buffer.byteLength(body) > REQUEST_LIMIT) throw new SafeError("Request exceeds 16 KiB.");
  return body;
}

function endpoint(env) {
  if (!env.GARDEN_SERVER || !env.GARDEN_TOKEN) {
    throw new SafeError("Garden endpoint/token unavailable. Run through exec_command with Garden loaded.");
  }
  const match = env.GARDEN_SERVER.match(/^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new SafeError("Invalid Garden endpoint.");
  const url = new URL(env.GARDEN_SERVER);
  url.pathname = "/mcp/call";
  return url;
}

const clean = (value, bound) => String(value)
  .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").slice(0, bound);

function httpError(status, text) {
  let error;
  try { error = JSON.parse(text)?.error; } catch {}
  // Only the extension's structured error shape is echoed; a proxy's HTML or
  // arbitrary body is not.
  if (error && typeof error.code === "string" && /^[a-z_]{1,64}$/.test(error.code)) {
    const lines = [`MCP call failed: ${error.code}${typeof error.message === "string" ? `: ${clean(error.message, 300)}` : ""}`];
    if (error.outcomeUnknown === true)
      lines.push("Outcome unknown: the tool may have run. Do not retry automatically.");
    if (error.executionCompleted === true)
      lines.push("The tool completed but its output was not delivered. Do not repeat the call to recover it.");
    return new SafeError(lines.join("\n"));
  }
  if (status === 404) return new SafeError("MCP call capability is not bound. Check Garden, then reload.");
  if (status === 504) return new SafeError("Garden request timed out. Outcome unknown; do not retry automatically.");
  return new SafeError(`Garden request failed (HTTP ${status}).`);
}

// Render content blocks as plain text. Anything not rendered here remains in
// the saved response file, which is announced whenever data was omitted.
function render(result) {
  const parts = [];
  let omitted = false;
  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      if (block.annotations || block._meta) omitted = true;
    } else if (block?.type === "artifact_ref" && block.file && typeof block.file.path === "string") {
      parts.push(`[artifact ${block.kind} ${block.file.mimeType} ${block.file.bytes} bytes${block.imageReadable ? " imageReadable" : ""}] ${block.file.path}`);
      if (block.sourceUri || block.annotations || block._meta) omitted = true;
    } else if (block?.type === "resource" && typeof block.resource?.text === "string") {
      parts.push(`[resource ${block.resource.uri ?? ""}]\n${block.resource.text}`);
    } else if (block?.type === "resource_link" && typeof block.uri === "string") {
      parts.push(`[link] ${block.uri}${typeof block.name === "string" ? ` ${block.name}` : ""}`);
      if (block.description) omitted = true;
    } else parts.push(JSON.stringify(block));
  }
  if (result.structuredContent !== undefined) {
    // Text content conventionally mirrors structuredContent; print it only
    // when it is the sole payload.
    if (!parts.length) parts.push(JSON.stringify(result.structuredContent));
    else omitted = true;
  }
  if (result._meta !== undefined) omitted = true;
  return { text: parts.join("\n"), omitted };
}

async function print(stream, text, signal) {
  let abort;
  try {
    await new Promise((resolve, reject) => {
      abort = () => { stream.destroy(); reject(new SafeError("Output cancelled.")); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      stream.write(text, (error) => error ? reject(error) : resolve());
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function save(text, signal) {
  let directory;
  try {
    directory = await mkdtemp(join(resolve(process.env.TMPDIR || tmpdir()), "mcp-"));
    const path = join(directory, "response.json");
    await writeFile(path, text, { flag: "wx", mode: 0o600, signal });
    return path;
  } catch {
    throw new SafeError(`The call completed but its response could not be saved. Do not repeat it.${directory ? ` Partial artifacts: ${directory}` : ""}`);
  }
}

async function main(signal) {
  const url = endpoint(process.env);
  const body = await request(process.argv.slice(2), signal);
  signal.throwIfAborted();
  // Node fetch ignores proxy environment variables by default. Honor Garden's
  // supplied values without rewriting its proxy or bypass list.
  setGlobalProxyFromEnv();
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${process.env.GARDEN_TOKEN}`, "content-type": "application/json" },
    body,
    signal,
  });
  if (!response.body) throw new SafeError("Missing Garden response.");
  const text = await readBounded(response.body, RESPONSE_LIMIT, signal);
  if (!response.ok) throw httpError(response.status, text);
  let value;
  try {
    value = JSON.parse(text);
    if (!value?.result || typeof value.result !== "object") throw new Error();
  } catch {
    throw new SafeError("Invalid MCP call response. The tool may have run; do not retry automatically.");
  }
  const { text: output, omitted } = render(value.result);
  const path = await save(text, signal);
  const header = omitted || value.rawResult !== undefined || Buffer.byteLength(output) > INLINE_LIMIT ? `Full response: ${path}\n` : "";
  const isError = value.result.isError === true;
  if (isError) await print(process.stderr, "MCP tool returned isError: true.\n", signal);
  await print(process.stdout, header + output + (output.endsWith("\n") ? "" : "\n"), signal);
  return isError ? 2 : 0;
}

const controller = new AbortController();
process.stdout.on("error", () => {});
let interrupted;
const onInterrupt = () => { interrupted = "SIGINT"; controller.abort(); };
const onTerminate = () => { interrupted = "SIGTERM"; controller.abort(); };
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
// Garden's call deadline is 55 seconds; allow delivery slack beyond it.
const timer = setTimeout(() => controller.abort(), 65_000);
try {
  process.exitCode = await main(controller.signal);
} catch (error) {
  const message = controller.signal.aborted
    ? interrupted ? "MCP call cancelled. Outcome unknown." : "MCP call timed out. Outcome unknown; do not retry automatically."
    : error instanceof SafeError ? error.message : "MCP call failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
} finally {
  clearTimeout(timer);
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  if (controller.signal.aborted) process.exit(process.exitCode ?? 1);
}
