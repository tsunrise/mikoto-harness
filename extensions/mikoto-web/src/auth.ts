import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WebError } from "./errors.ts";

export type AuthRegistry = Pick<ExtensionContext["modelRegistry"],
  "getProviderAuthStatus" | "getProviderAuth" | "getProvider">;
export type Provider = "openai-codex" | "openai";
export type WebAuth = {
  provider: Provider;
  endpoint: string;
  headers: Record<string, string>;
};

const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const reservedHeaders = new Set([
  "authorization", "accept", "content-type", "content-length", "host", "originator",
  "chatgpt-account-id", "cookie", "connection", "transfer-encoding",
]);
const headerSafe = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max &&
  /^[\x21-\x7e]+$/.test(value);
const headerName = (name: string) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(name);
const headerValue = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 8 * 1024 &&
  /^[\x20-\x7e]+$/.test(value);

function accountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const id: unknown = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (headerSafe(id, 1024)) return id;
  } catch {
    // JWT decoding supplies routing metadata only. OpenAI authenticates it.
  }
  throw new WebError("auth_unavailable");
}

/** `${baseUrl}/alpha/search` for an HTTPS base URL without credentials, query, or fragment. */
export function openaiEndpoint(baseUrl: unknown): string {
  if (typeof baseUrl !== "string" || baseUrl.length > 2048) throw new WebError("auth_unavailable");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new WebError("auth_unavailable"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new WebError("auth_unavailable");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/alpha/search`;
  return url.href;
}

/** Provider and credential headers the OpenAI provider already sends to its own endpoint. */
function providerHeaders(...layers: Array<Record<string, unknown> | undefined>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer ?? {})) {
      const lower = name.toLowerCase();
      if (!headerName(name) || reservedHeaders.has(lower)) continue;
      // Null deletes an inherited header in Pi's provider header model.
      if (value === null) delete headers[lower];
      else if (headerValue(value)) headers[lower] = value;
    }
  }
  return headers;
}

export function createAuthResolver(registry: AuthRegistry) {
  const pending = new Map<Provider, Promise<WebAuth>>();

  async function resolveProvider(provider: Provider): Promise<WebAuth> {
    try {
      const resolved = await registry.getProviderAuth(provider);
      const key = resolved?.auth.apiKey;
      if (!headerSafe(key, 32 * 1024)) throw new WebError("auth_unavailable");
      const base = { accept: "application/json", "content-type": "application/json", originator: "pi" };
      if (provider === "openai-codex") {
        // The subscription endpoint is fixed. Provider redirects and headers
        // must never receive the ChatGPT token.
        return {
          provider,
          endpoint: CODEX_ENDPOINT,
          headers: { ...base, authorization: `Bearer ${key}`, "chatgpt-account-id": accountId(key) },
        };
      }
      // The API-key path follows the registered OpenAI provider (for example
      // an AI gateway), sending the credential only where Pi's own OpenAI
      // requests already go.
      const registered = registry.getProvider(provider);
      const endpoint = openaiEndpoint(resolved?.auth.baseUrl ?? registered?.baseUrl ?? OPENAI_BASE_URL);
      return {
        provider,
        endpoint,
        headers: {
          ...providerHeaders(registered?.headers, resolved?.auth.headers),
          ...base,
          authorization: `Bearer ${key}`,
        },
      };
    } catch {
      throw new WebError("auth_unavailable");
    }
  }

  return async (signal: AbortSignal): Promise<WebAuth> => {
    signal.throwIfAborted();
    let provider: Provider;
    try {
      if (registry.getProviderAuthStatus("openai-codex").configured) provider = "openai-codex";
      else if (registry.getProviderAuthStatus("openai").configured) provider = "openai";
      else throw new WebError("auth_unavailable");
    } catch {
      throw new WebError("auth_unavailable");
    }
    let work = pending.get(provider);
    if (!work) {
      work = resolveProvider(provider).finally(() => pending.delete(provider));
      pending.set(provider, work);
    }
    // Pi's public facade owns refresh locking and has no signal parameter.
    // Await it rather than abandoning refresh work; never fetch after abort.
    const auth = await work;
    signal.throwIfAborted();
    return auth;
  };
}
