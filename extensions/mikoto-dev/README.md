# Mikoto Dev

Mikoto Dev provides small developer diagnostics for Pi.

## System-prompt snapshot

Run:

```text
/debug-system-prompt
```

The command writes Pi's current system prompt to:

```text
~/.pi/agent/pi-debug-systemprompt.md
```

The agent directory is created if needed, and each invocation overwrites the
existing file. The command does not start an LLM turn or add a session message.

The snapshot is the value exposed by Pi's `ctx.getSystemPrompt()` API. It does
not include conversation messages, context-event message changes, or
provider-level request rewrites.

## Install

From the Mikoto Harness root:

```bash
pi install ./extensions/mikoto-dev
```

For a temporary test:

```bash
pi -e ./extensions/mikoto-dev
```

## Development

```bash
npm install
npm run validate -w mikoto-dev
```
