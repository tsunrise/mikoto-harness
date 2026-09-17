import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WebError } from "./errors.ts";

export type AuthRegistry = Pick<ExtensionContext["modelRegistry"],
  "getProviderAuthStatus" | "getProviderAuth">;
export type Provider = "openai-codex" | "openai";
export type WebAuth = {
  provider: Provider;
  endpoint: string;
  headers: Record<string, string>;
};

const endpoints = {
  "openai-codex": "https://chatgpt.com/backend-api/codex/alpha/search",
  openai: "https://api.openai.com/v1/alpha/search",
} as const;
const headerSafe = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max &&
  /^[\x21-\x7e]+$/.test(value);

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

export function createAuthResolver(registry: AuthRegistry) {
  const pending = new Map<Provider, Promise<WebAuth>>();

  async function resolveProvider(provider: Provider): Promise<WebAuth> {
    try {
      const resolved = await registry.getProviderAuth(provider);
      const key = resolved?.auth.apiKey;
      if (!headerSafe(key, 32 * 1024)) throw new WebError("auth_unavailable");
      const headers: Record<string, string> = {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        "content-type": "application/json",
        originator: "pi",
      };
      if (provider === "openai-codex") {
        headers["chatgpt-account-id"] = accountId(key);
      } else {
        for (const [name, value] of Object.entries(resolved?.auth.headers ?? {})) {
          const lower = name.toLowerCase();
          if ((lower === "openai-organization" || lower === "openai-project") && headerSafe(value, 1024)) {
            headers[lower] = value;
          }
        }
      }
      // Neither baseUrl overrides nor arbitrary headers belong on this narrow
      // endpoint. In particular, a provider proxy must not receive these tokens.
      return { provider, endpoint: endpoints[provider], headers };
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
