import { createHash } from "node:crypto";
import type { WebAuth, Provider } from "./auth.ts";
import type { Commands } from "./schema.ts";
import { WebError } from "./errors.ts";

export const RESPONSE_LIMIT = 100 * 1024 * 1024;
export type Fetch = typeof globalThis.fetch;
export type SearchResult = { output: string; results: unknown[] | null };

export function searchSessionId(sessionId: string, provider: Provider): string {
  return createHash("sha256").update(`mikoto-web:v1\n${sessionId}\n${provider}`).digest("hex");
}

export function searchModel(model: { provider: string; id: string } | undefined): string {
  return model && (model.provider === "openai" || model.provider === "openai-codex")
    ? model.id : "gpt-5.4";
}

export async function readResponse(
  response: Response,
  signal: AbortSignal,
  limit = RESPONSE_LIMIT,
): Promise<string> {
  if (!response.body) throw new WebError("invalid_upstream_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Fetch observes the signal itself. Explicit reader cancellation also makes
  // bounded reads cooperate with injected transports and aborts between chunks.
  let cancellation: Promise<void> | undefined;
  const cancel = () => { cancellation ??= reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new WebError("response_too_large");
      chunks.push(value);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
    } catch {
      throw new WebError("invalid_upstream_response");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    await cancellation;
    reader.releaseLock();
  }
}

export function parseResult(text: string): SearchResult {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || typeof value.output !== "string" ||
      (value.results != null && !Array.isArray(value.results))) throw new Error();
    // Structured results are opaque DTOs upstream. Preserve new variants, but
    // never spread the envelope: encrypted_output is not agent-facing content.
    return { output: value.output, results: value.results ?? null };
  } catch {
    throw new WebError("invalid_upstream_response");
  }
}

export async function search(
  request: { sessionId: string; model: string; commands: Commands; auth: WebAuth; signal: AbortSignal },
  options: { fetch?: Fetch; timeoutMs?: number; responseLimit?: number } = {},
): Promise<string> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 55_000);
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  const limit = options.responseLimit ?? RESPONSE_LIMIT;
  try {
    signal.throwIfAborted();
    const response = await (options.fetch ?? globalThis.fetch)(request.auth.endpoint, {
      method: "POST",
      redirect: "error",
      headers: request.auth.headers,
      body: JSON.stringify({
        id: searchSessionId(request.sessionId, request.auth.provider),
        model: request.model,
        commands: request.commands,
      }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) {
        throw new WebError("upstream_auth_error", response.status);
      }
      throw new WebError(response.status === 429 ? "rate_limited" : "upstream_error", response.status);
    }
    const body = JSON.stringify(parseResult(await readResponse(response, signal, limit)));
    if (Buffer.byteLength(body) > limit) throw new WebError("response_too_large");
    signal.throwIfAborted();
    return body;
  } catch (error) {
    request.signal.throwIfAborted();
    if (timeout.signal.aborted) throw new WebError("upstream_timeout");
    throw error instanceof WebError ? error : new WebError("upstream_error");
  } finally {
    clearTimeout(timer);
  }
}
