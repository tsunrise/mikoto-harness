# Mikoto Web

Binds `POST /web/run` to Garden for batched `search_query`, `open`, `click`,
and `find` operations.

Reuses Pi authentication, preferring the Codex subscription:

- Codex: `https://chatgpt.com/backend-api/codex/alpha/search`
- Otherwise, the `openai` provider: `<baseUrl>/alpha/search`, where `baseUrl`
  is the credential's base URL, else the registered `openai` provider's base
  URL (for example an AI gateway extension), else `https://api.openai.com/v1`.
  The provider's headers and resolved credential headers are forwarded, so a
  gateway provider must expose its authentication through provider auth, not
  only inside `streamSimple`. The base URL must be HTTPS.

The Codex endpoint is fixed and never follows provider redirects or headers.
No capability is bound without usable credentials. Subscription failures do
not fall back to API billing.
