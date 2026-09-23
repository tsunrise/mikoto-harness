# Mikoto Garden

*Run your command inside a garden.*

Mikoto Garden replaces Pi's model-facing `bash` tool with managed command
execution that can continue in the background. Commands run in an SRT sandbox
by default, with user-approved escalation to host execution, and can access
authenticated custom capabilities exposed by other extensions.

## Install and load

From the Mikoto Harness root:

```sh
npm install
npm run build -w mikoto-garden
```

Load `extensions/mikoto-policy` before the Garden package, and load
extensions that bind Garden capability routes afterward. All participating
Mikoto extensions must use the same `mikoto-types` commit.

Both directories are Pi packages. Loading them by directory follows their
`package.json` manifests, so Garden's bundled capability-creation skill is
discovered automatically:

```sh
pi -e extensions/mikoto-policy -e extensions/mikoto-garden
```

## Tools provided

- `exec_command` launches a fresh managed shell, sandboxed by default, and
  returns a session ID when the command remains active.
- `write_stdin` waits for or collects output and can send input, EOF, or an
  interrupt to a managed command.

The current tool descriptions, parameter schemas, wait bounds, and validation
rules are defined in `src/tools.ts`.

## Policy and capability integration

Garden obtains an immutable, session-scoped policy snapshot from Mikoto Policy.
It translates that snapshot into SRT filesystem and network enforcement;
explicit host launches and later host mutations use Policy's one-operation
approval broker.

Each session also attempts to create an authenticated loopback HTTP endpoint.
Its address and bearer token are exposed only to that session's commands as
`GARDEN_SERVER` and `GARDEN_TOKEN`. Garden accepts narrow routes from other
extensions through the typed `mikoto-garden:bind` event. See
`examples/binding.ts` for a binding example and
`skills/capability-creator/SKILL.md` for creating a capability extension with
its own usage skill. Terminal notifications are provided separately by the
`mikoto-terminal-notify` extension.

Capability requests have a global 60-second deadline, a 16 KiB request-body
limit, and a 100 MiB UTF-8 response-body limit. Shell-output truncation bounds
model-visible output, not host memory: concurrent handlers can still buffer
large responses.

## System prompt injection

Before each agent run, Garden appends a short deterministic `<sandbox>` block
to Pi's system prompt. It explains sandboxing, manual escalation,
and long-running command polling; Mikoto Policy separately owns the effective
filesystem and network rules.

Garden does not inject job snapshots, endpoint addresses, or bearer tokens into
the model context. The injected text is defined in `src/prompt.ts`.

## `/ps` UI

In Pi's interactive mode, `/ps` adds a UI overlay for managing in-progress and
unread finished commands. The command and overlay implementation is in
`src/ui.ts` and `src/process-picker.ts`.
