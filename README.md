# Mikoto Harness: An opinionated agent setup for Pi

This repository contains extensions and skills for
[Pi Coding Agent](https://pi.dev/) that serve as building blocks for the
personal agent system *Mikoto*.

## Extensions

- [Mikoto Question](mikoto-question/) — adds Codex-compatible interactive
  questions and a turn-scoped Do not disturb mode.
- [Mikoto Zed](mikoto-zed/) — attaches the active Zed editor, cursor, and
  selections to Pi prompts.

Each extension is an independently installable local Pi package:

```bash
pi install /absolute/path/to/mikoto-harness/mikoto-question
pi install /absolute/path/to/mikoto-harness/mikoto-zed
```

See each extension's README for usage, configuration, and development
instructions.

## Migration

The former standalone packages now live in this monorepo under new names:

- `pi-user-input` → `mikoto-question`
- `pi-zed-context` → `mikoto-zed`

Their LLM-facing interfaces remain stable, including `request_user_input`,
`zed_context`, `/zed-context`, and the existing Zed environment variables.

## Extension Interoperability

- Some extensions in the repo require one or more extensions in the repo to be
  loaded first.
- No extension in the repo requires an extension outside this repo.
- Every extension in the repo guarantees no conflict with the other extensions
  in this repo.
- No extension guarantees compatibility with extensions outside this repo.
