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

`extensions/mikoto-web/` provides authenticated OpenAI web-search capabilities
for Garden commands and bundles the `web` skill.

`extensions/mikoto-mcp/` provides cached MCP discovery through `mcp_tool_search`
and host execution through Garden's `/mcp/call`, with the short `mcp` skill.
`/mcp` and `/mcp:verbose` inspect catalogs using notifications only. See its
README for configuration, host-authority implications, and temporary media.

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

- Some extensions in the repo require one or more extensions in the repo to be
  loaded first.
- No extensions in the repo require an extension outside this repo.
- Every extension in the repo guarantees no conflict with the other extensions
  in this repo.
- No extensions guarantee compatibility with extensions outside this repo.
