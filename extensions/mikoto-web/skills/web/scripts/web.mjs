import { mkdtemp, writeFile } from "node:fs/promises";
import { setGlobalProxyFromEnv } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REQUEST_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 100 * 1024 * 1024;
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

async function input(argument, signal) {
  if (argument !== "-") {
    if (Buffer.byteLength(argument) > REQUEST_LIMIT) throw new SafeError("Request exceeds 16 KiB.");
    return argument;
  }
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

function endpoint(env) {
  if (!env.GARDEN_SERVER || !env.GARDEN_TOKEN) {
    throw new SafeError("Garden endpoint/token unavailable. Run through exec_command with Garden loaded.");
  }
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(env.GARDEN_SERVER)) {
    throw new SafeError("Invalid Garden endpoint.");
  }
  const url = new URL(env.GARDEN_SERVER);
  const port = Number(env.GARDEN_SERVER.match(/:(\d+)\/?$/)[1]);
  if (port < 1 || port > 65535) throw new SafeError("Invalid Garden endpoint.");
  url.pathname = "/web/run";
  return url;
}

function httpError(status, text) {
  // Only recognize our error codes. Neither a proxy's HTML response nor a
  // server-authored message is safe to echo into a shell diagnostic.
  const messages = {
    auth_unavailable: "Web authentication unavailable. Check Pi login and reload.",
    upstream_auth_error: "OpenAI rejected web access. Check Pi login and endpoint access.",
    rate_limited: "Web search is busy or rate limited. Try again later.",
    upstream_timeout: "OpenAI web search timed out.",
    upstream_error: "OpenAI web search request failed.",
    invalid_upstream_response: "OpenAI returned an invalid web response.",
    response_too_large: "Web response exceeds the 100 MiB limit.",
  };
  try {
    const code = JSON.parse(text)?.error?.code;
    if (typeof code === "string" && Object.hasOwn(messages, code)) return new SafeError(messages[code]);
  } catch {}
  if (status === 404) return new SafeError("Web capability is not bound. Check Pi login and Garden, then reload.");
  if (status === 504) return new SafeError("Garden request timed out.");
  return new SafeError(`Garden request failed (HTTP ${status}).`);
}

async function print(text, signal) {
  // The callback waits until Node has handled the write. Do not enqueue an
  // entire large result as many unchecked writes behind a slow stdout pipe.
  let abort;
  try {
    await new Promise((resolve, reject) => {
      abort = () => {
        // A stopped stdout consumer must not keep a canceled helper alive.
        process.stdout.destroy();
        reject(new SafeError("Output cancelled."));
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      process.stdout.write(text, (error) => error ? reject(error) : resolve());
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function main(signal) {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new SafeError("Usage: node web.mjs '<commands JSON>' (or - for stdin)");
  const url = endpoint(process.env);
  const body = await input(args[0], signal);
  try { JSON.parse(body); } catch { throw new SafeError("Invalid JSON input."); }
  signal.throwIfAborted();
  // Unlike curl, Node fetch does not use proxy environment variables by
  // default. Honor Garden's supplied values without rewriting its proxy or
  // bypass list; direct loopback connections are not the capability grant.
  setGlobalProxyFromEnv();
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${process.env.GARDEN_TOKEN}`,
      "content-type": "application/json",
    },
    body,
    signal,
  });
  if (!response.body) throw new SafeError("Missing Garden response.");
  const text = await readBounded(response.body, RESPONSE_LIMIT, signal);
  if (!response.ok) throw httpError(response.status, text);
  let result;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value.output !== "string" ||
      (value.results != null && !Array.isArray(value.results))) throw new Error();
    result = { output: value.output, results: value.results ?? null };
  } catch {
    throw new SafeError("Invalid web response.");
  }
  signal.throwIfAborted();
  let directory;
  let responsePath;
  let outputPath;
  try {
    directory = await mkdtemp(join(resolve(process.env.TMPDIR || tmpdir()), "web-"));
    responsePath = join(directory, "response.json");
    outputPath = join(directory, "output.txt");
    await writeFile(responsePath, JSON.stringify(result), { flag: "wx", mode: 0o600, signal });
    await writeFile(outputPath, result.output, { flag: "wx", mode: 0o600, signal });
  } catch {
    throw new SafeError(`Could not save web output.${directory ? ` Partial artifacts: ${directory}` : ""}`);
  }
  signal.throwIfAborted();
  await print(`Response JSON: ${responsePath}\nFull output: ${outputPath}\n\n`, signal);
  await print(result.output, signal);
  if (!result.output.endsWith("\n")) await print("\n", signal);
}

const controller = new AbortController();
// Write callbacks report pipe failures; avoid an uncaught error/stack trace
// when a consumer exits early (for example, piping this helper into head).
process.stdout.on("error", () => {});
let interrupted;
const onInterrupt = () => { interrupted = "SIGINT"; controller.abort(); };
const onTerminate = () => { interrupted = "SIGTERM"; controller.abort(); };
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
const timer = setTimeout(() => controller.abort(), 65_000);
try {
  await main(controller.signal);
} catch (error) {
  const message = controller.signal.aborted
    ? interrupted ? "Web request cancelled." : "Web request timed out."
    : error instanceof SafeError ? error.message : "Web request failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
} finally {
  clearTimeout(timer);
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  // Node treats process.stdout specially: destroy() alone may leave a native
  // write waiting on a stopped pipe reader. Once cancellation has unwound our
  // fetch/file work, discard pending stdout rather than waiting to flush it.
  if (controller.signal.aborted) process.exit(process.exitCode ?? 1);
}
