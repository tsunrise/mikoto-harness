# Mikoto Harness: An opinionated agent setup for Pi

This repository contains extension packages, standalone skills, and shared libraries for
[Pi Coding Agent](https://pi.dev/) that serve as building blocks for my
personal agent system *Mikoto*. Some extension packages bundle Pi skills.

## Repository layout

- `extensions/*` contains independently installable Pi extension packages,
  including any skills bundled with those extensions.
- `skills/*` contains standalone Pi skills (configure Pi's `skills` setting
  to point to this directory).
- `shared/*` contains declaration-only or runtime libraries shared by
  extensions.

The root is a private npm workspace.

`extensions/mikoto-web/` provides public web research through Pi's built-in
codemode with deferred schema discovery and a stable model-facing tool set.
It needs OpenAI credentials but works with any conversation provider.

`skills/plan/` provides `/skill:plan <task>` for conversational planning
with a Markdown deliverable. It does not add a persistent mode or an
implementation handoff command. See its README for setup and usage.

`extensions/mikoto-vscode-context/` captures the active VS Code file and
selections for Pi prompts, with `/vscode toggle` and `/vscode preview`.
Install its companion local VSIX from `vscode/mikoto/` and start Pi in a
**new VS Code integrated terminal**. See both package READMEs for setup and
the privacy implications of persistent editor snapshots.

`vscode/mikoto/` is a standalone npm package, not a root workspace.
Root validation does **not** check it; run `npm install` and
`npm run validate` in that directory separately.
See `docs/vscode-context-validation.md` for implementation validation results
and the remaining live smoke-test checklist.

```bash
npm install

# Build every package that has a build step (e.g. mikoto-apply-patch's
# native addon, mikoto-garden's compiled output):
npm run build

# Build one package:
npm run build -w mikoto-garden

# Validate one package without running the entire workspace:
npm run validate -w mikoto-sound

# Explicitly validate every package:
npm run validate
```

## Extension Interoperability

Use Pi 1.0.2 or later. Enable codemode before the first prompt:

```json
{
  "defaultTools": ["+codemode"],
  "codemode": { "mode": "on" }
}
```

Keep frequently used tools directly available. Garden tools also return
structured data to codemode for batching, filtering, and chaining calls;
permission checks still run for each nested call. Interactive questions stay
model-facing rather than callable from scripts.

MCP is provided by Pi itself. Configure `mcpServers` in
`~/.pi/agent/mcp.json` or a trusted project's `.pi/mcp.json`, and use `pi mcp`
or `/mcp` for connection management. Use server exposure `"codemode"` (Pi's
default), with a short configured `description`, for minimal initial context.
Discover tools inside scripts with `searchTools()`, `describeTool()`, and
`describeNamespace()`. Unlike `tool_search`, these do not activate tools or
change the model-facing declarations. Avoid `"deferred"` MCP exposure and
mid-session tool activation when cache stability matters.

MCP tools and web run host-side, outside Garden's shell sandbox. Only configure
trusted servers; sandbox network rules do not constrain their actions.

- Some extensions in the repo require one or more extensions in the repo to be
  loaded first.
- No extensions in the repo require an extension outside this repo.
- Every extension in the repo guarantees no conflict with the other extensions
  in this repo.
- No extensions guarantee compatibility with extensions outside this repo.
