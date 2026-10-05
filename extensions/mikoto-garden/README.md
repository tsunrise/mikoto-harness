# Mikoto Garden

*Run your command inside a garden.*

Mikoto Garden replaces Pi's model-facing `bash` tool with managed command
execution that can continue in the background. Commands run in an SRT sandbox
by default, with user-approved escalation to host execution.

## Install and load

From the Mikoto Harness root:

```sh
npm install
npm run build -w mikoto-garden
```

Requires macOS, Node 26+, and Pi 1.0.2+. Load `extensions/mikoto-policy`
before the Garden package. All participating
Mikoto extensions must use the same `mikoto-types` commit.

Both directories are Pi packages:

```sh
pi -e extensions/mikoto-policy -e extensions/mikoto-garden
```

## Tools provided

- `exec_command` launches a fresh managed shell, sandboxed by default, and
  returns a session ID when the command remains active.
- `write_stdin` waits for or collects output and can send input, EOF, or an
  interrupt to a managed command.
- `list_commands` lists running or uncollected managed commands so the agent
  can recover session IDs.
- `stop_command` terminates a managed command's process group (SIGTERM, then
  SIGKILL) and returns its final unread output. The agent does not need to
  send a literal Ctrl-C character. Stopping an unsandboxed command requires a
  justification and a fresh approval, like other unsandboxed mutations.

The current tool descriptions, parameter schemas, wait bounds, and validation
rules are defined in `src/tools.ts`.

## Policy integration

Garden obtains an immutable, session-scoped policy snapshot from Mikoto Policy.
It translates that snapshot into SRT filesystem and network enforcement,
including Policy's opt-in `allowLocalBinding` and `allowUnixSockets` grants
for direct loopback and Unix-socket IPC (both closed by default);
explicit host launches and later host mutations use Policy's one-operation
approval broker.

Policy chooses `ask-me` (default, TUI only), `auto-review` (all modes), or
`always-deny`. Launch review receives the prepared command, cwd, shell,
login/stdin flags, authority, PATH and identity facts—not the full environment.
Each unsandboxed input/EOF/interrupt gets a
fresh review containing the managed ID, original command/cwd, stdin state and
exact operation/characters; so does each agent `stop_command` on a live
unsandboxed command. Sandboxed launches and output-only polls bypass
escalation. Post-approval runtime/process checks still apply.
Rejection reasons are returned in normal tool errors, never a separate
decision-history entry or reviewer display.

On macOS, Garden enables SRT's weaker network isolation so Go programs can
reach `com.apple.trustd.agent` for TLS certificate verification. Destination
allow/deny rules still apply to proxied traffic, but trustd access can provide
a separate data-exfiltration path. Use Garden only with workloads trusted for
that additional access.

## Codemode

Garden tools remain directly available and are also callable from Pi's
codemode. Command calls resolve to structured results with `session_id`,
`output`, `running`, exit status, sandbox mode and truncation information.
`list_commands` resolves to `{ jobs }`. Scripts do not need to parse terminal
headers. Permission checks and escalation apply to every nested call.

```js
const result = await tools.exec_command({ cmd: "git status --short" });
text({ output: result.output, running: result.running, id: result.session_id });
```

Wait for `exec_command` before using its returned ID. Output collection is
consuming, so do not poll the same command concurrently. Large outputs stay
bounded; read `full_output_path` when present and permitted.

## System prompt injection

Before each agent run, Garden appends a short deterministic `<sandbox>` block
to Pi's system prompt. It explains sandboxing, manual escalation,
and long-running command polling; Mikoto Policy separately owns the effective
filesystem and network rules.

Garden does not inject job snapshots into the model context.
The injected text is defined in `src/prompt.ts`.

## `/ps` UI

In Pi's interactive mode, `/ps` adds a UI overlay for managing in-progress and
unread finished commands. The command and overlay implementation is in
`src/ui.ts` and `src/process-picker.ts`.
