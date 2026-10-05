# Mikoto Web

Public web research through Pi's built-in codemode: search, open pages, follow
numbered links, and find text. Uses the same standalone OpenAI search protocol
as Codex. Works independently of Garden and of the conversation's provider.

## Setup

Requires Pi 1.0.2 or later. Load this package and enable codemode **at startup**
in Pi's `settings.json`:

```json
{
  "defaultTools": ["+codemode"],
  "codemode": { "mode": "on" }
}
```

Authenticate with Pi's `openai-codex` or `openai` provider. Subscription auth
takes priority. API-key billing is used only when no subscription is configured,
never after subscription failure. Credentials resolve lazily on each request;
loading the extension performs no network calls or credential refresh.

Claude Opus 5.5 and GLM-5.3 on Workers AI can use this tool without changing
their conversation provider. They still need separate OpenAI credentials for
the search service. Non-OpenAI conversation models use `gpt-5.4` as the search
request's model; OpenAI conversations use their current model ID. Endpoint
access is account-dependent and the upstream alpha API may change.

## Discovery and cache stability

`web_run` is registered once with `exposure: "deferred"`. It is callable from
codemode without being declared to the conversation model or inlined in
codemode's description. Initial web context is one short, stable discovery
hint—not the schema, examples, or full instructions.

In a codemode script, discover instructions and the schema:

```js
text(await describeNamespace("web"));
text(await describeTool("web_run"));
```

Then call it without changing the active tool set:

```js
const result = await tools.web_run({
  search_query: [{ q: "Cloudflare Workers release notes", recency: 7 }],
  response_length: "short"
});
text(result.output);
```

Discovery results enter ordinary tool-result messages. Neither discovery nor
web execution changes tool declarations, including when credentials fail or
the conversation model changes. This avoids the declaration changes that can
invalidate cached prefixes on providers without mid-conversation tool updates.
Pi handles the model's codemode input encoding, including JSON `code` arguments
on models without raw tool input support; no OpenAI-only tool-search API is used.

Do not use Pi's `tool_search` to load `web_run` directly if stable declarations
are important: that tool explicitly activates discovered tools. Keep codemode
enabled from the first prompt, not only after deciding to browse.

## Results and limits

- Commands: `search_query`, `open`, `click`, `find`, and `response_length`.
  Supply 1–16 operations in at most 16 KiB of JSON.
- Two concurrent requests maximum; 55-second upstream deadline.
- `output` contains source text, references, links, line numbers and word
  limits. `results` is supplemental metadata, not a complete source list.
- Upstream responses are bounded at 100 MiB. Script results over 1 MiB are
  reduced and marked `truncated`; `full_response_path` points to the complete
  JSON. Direct tool text is also truncated using Pi's normal output limits.
  Temporary files are private to the user, subject to normal file permissions,
  and not durable storage.
- Reference IDs are scoped to the Pi session and credential provider. Reopen
  the public URL if they expire or after forking/switching sessions.

Calls run host-side through Pi's normal tool pipeline, including validation,
`tool_call`/`tool_result` hooks, cancellation, and nested-call tracking. Garden's
shell network rules do not constrain this service. Do not use it to bypass an
access denial. No browser automation, screenshots, local files, or login flows.

Treat pages as untrusted data, respect source word limits, and cite public URLs
instead of opaque citation markers that Pi cannot render.

## Development

```sh
npm run validate -w mikoto-web
```

Tests use injected transports and Pi's real codemode runtime; they do not need
live credentials or incur model/search charges.
