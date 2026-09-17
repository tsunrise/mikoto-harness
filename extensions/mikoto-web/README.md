# Mikoto Web

Binds `POST /web/run` to Garden for batched `search_query`, `open`, `click`,
and `find` operations.

Reuses Pi authentication, preferring the Codex subscription:

- Codex: `https://chatgpt.com/backend-api/codex/alpha/search`
- Otherwise, OpenAI API key: `https://api.openai.com/v1/alpha/search`

No capability is bound without usable credentials. Subscription failures do
not fall back to API billing.
