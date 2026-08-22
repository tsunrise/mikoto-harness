# Mikoto Zed

Mikoto Zed is a Pi extension that passes the active Zed file, cursor, and
selections to the `@earendil-works/pi-coding-agent` fork.

Adapted from the upstream
[`dafunction/pi-zed-context`](https://github.com/dafunction/pi-zed-context)
project (MIT). The database logic was independently compared with the OpenCode
Zed implementation and with a current Zed SQLite schema.

## LLM Usage Disclosure

My effort on this extension: 💡 I only own the idea

Refer to repo [README.md](../../README.md#LLM_usage_disclosure) for more details.

## What it does

On every submitted prompt, the extension reads Zed's local state database,
chooses the active editor in the workspace containing Pi's working directory,
and injects a hidden, persistent `zed-context` message into that turn. This
makes prompts such as “explain this selection” work without requiring the model
to call a tool first.

It also provides:

- `zed_context` — an agent-callable tool that refreshes the current context
- `/zed-context` — inspect the context Pi currently sees
- a live italic `filename:line` context beside the workspace path

Cursor-only context includes the file and cursor position without inserting the
whole file. Selected text is capped at 48 KiB by default, leaving room for the
context envelope below Pi's 50 KiB tool-output limit.

The footer polls Zed while Pi is running. The latest editor context is retained
when focus returns to Zed's integrated terminal, so changing files or selections
is reflected in both the TUI and the next submitted prompt.

The tool, command, polling, and footer integration are activated only when Pi
was launched from a verified Zed integrated-terminal process. If that Zed
process exits, the extension clears its UI and stops attaching context.
Previously stored `zed-context` messages are also excluded from subsequent
model requests while Zed is inactive, including when the session is resumed
from another terminal.

## Requirements

- `@earendil-works/pi-coding-agent`
- Zed
- the `sqlite3` CLI on `PATH`

Default database locations:

- macOS: `~/Library/Application Support/Zed/db/0-stable/db.sqlite`
- Linux: `~/.local/share/zed/db/0-stable/db.sqlite`

## Install

From this checkout:

```bash
pi install /absolute/path/to/mikoto-harness/extensions/mikoto-zed
```

Or, from the Mikoto Harness repository root, test without installing:

```bash
pi -e ./extensions/mikoto-zed
```

After installation, restart Pi (or run `/reload` if appropriate), open the
project in Zed, focus a file or select text, and run Pi from Zed's integrated
terminal. `/zed-context` shows exactly what will be passed.

## Configuration

```bash
# Override Zed's database path
export PI_ZED_DB=/path/to/db.sqlite

# Lower the selected-text budget in UTF-8 bytes (default/max: 49152)
export PI_ZED_MAX_CONTEXT_BYTES=16384
```

`OPENCODE_ZED_DB` remains supported as a lower-priority compatibility alias.

## Privacy and behavior

The extension reads local Zed state and selected/file contents only. It does
not write to the database or make network requests. Context is scoped to a Zed
workspace that contains Pi's current working directory, preventing an active
file from an unrelated workspace from being attached.

Each injected context message is stored in the Pi session so the conversation
remains reproducible. New prompts refresh the context; previous turns keep the
context they actually used in session storage. Stored Zed messages are not sent
to the model while the extension is inactive.

## Development

```bash
# From the Mikoto Harness root:
npm install
npm run validate -w mikoto-zed

# Or from this package directory:
npm run validate
```

## License

MIT under the Mikoto Harness repository's root `LICENSE`. The original
implementation is copyright Alec G; adaptation changes are copyright their
contributors.
