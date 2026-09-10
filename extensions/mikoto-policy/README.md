# Mikoto Policy

Mikoto Policy is a Pi extension that enforces filesystem permissions for Pi's
built-in file tools and exposes a policy API to dependent extensions in Mikoto
Harness.

## Configuration

See [PERMISSION.md](PERMISSION.md) for policy semantics.

Run `/mikoto-policy:view` to display the active config paths and resolved
canonical policy. Policy changes and policy-rule symlink changes take effect
after `/reload`.

The JSON Schema is available at
[mikoto-policy.schema.json](mikoto-policy.schema.json).

## Path terminology

- A **lexical path** is a path with possible symlink redirection.
- A **canonical path** is the target path after resolving existing symlink
  redirections; it contains no symlink redirections at the time it is resolved.

## Behavior

Built-in tool calls to `read`, `grep`, `find`, `ls`, `write`, and `edit` are
enforced according to the configured policy. Filesystem authorization is split
into three stages with separate responsibilities:

1. **Target determination** owns lexical-to-canonical path resolution. It pins
   the exact canonical target that the tool proposes to access. A failure to
   determine that target denies the operation.
2. **Policy evaluation** owns the allow-or-deny decision for the pinned
   canonical target. Evaluation is filesystem-independent, accepts normalized
   absolute canonical paths only, and does not resolve symlinks.
3. **Tool execution or commit** owns canonical-path enforcement. The tool must
   operate on the exact canonical target that policy approved rather than
   reopening the lexical path.

Policy rule paths are also resolved to canonical paths when the policy is
loaded and remain pinned until `/reload`. Missing paths are supported by
resolving their deepest existing ancestor and appending the missing suffix. A
rule that cannot be resolved for another reason is dropped and reported as a
warning during `session_start`. An allow rule that resolves outside its
configured lexical tree is likewise dropped and reported.

`bash` is not enforced in this extension and it should be enforced in other
extensions.

The extension adds a Permissions section to the system prompt so the agent is
aware of the effective filesystem and network policies.

## Escalation

Each escalation requires manual user action. The system prompt tells the model
to work within the policy, avoid repeated requests, and expect automatic
escalation from tools without an explicit escalation parameter. See
[PERMISSION.md](PERMISSION.md#one-time-exceptions) for details.

## Inter-extension API

Dependent extensions obtain the session policy through
`mikoto-policy:get-policy` and request one-operation decisions through
`mikoto-policy:escalate`. Load Policy first and use the same `mikoto-types`
commit.

See [Building permission-aware extensions](../../docs/permission.md) for the
integration contract and examples.

## Development

From the Mikoto Harness root:

```bash
npm run validate -w mikoto-policy
```

The affected development baseline is Pi **0.85.1**. Tests cover real SDK
integration and built-in interception as well as broker/UI races.
For a no-operation real-TUI smoke test, explicitly load
`test/fixtures/escalation-smoke.ts` after this extension and run
`/escalation-smoke`. The same command rejects in print, JSON, and RPC modes.

Core escalation lives in `src/escalate/{index,api,broker,ui}.ts`; built-in
policy enforcement requests decisions directly from the broker.
