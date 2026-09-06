# Mikoto Policy

A Mikoto policy describes permitted and denied operations.

## Policy Locations

Policy is loaded from these locations, from lowest to highest precedence:

1. The bundled `mikoto-policy.default.json`.
2. `mikoto-policy.json` in the Pi agent directory.
3. `mikoto-policy.json` in the trusted workspace root.

Objects are merged recursively. Arrays may either be replaced with a plain
array or changed with a delta object:

```json
{
  "filesystem": {
    "allowWrite": {
      "+": ["generated/"],
      "-": ["dist/"]
    }
  }
}
```

A delta adds the values in `+` and removes the values in `-`. Removal wins
when the same value appears in both. Values of all other types replace the
value from the previous layer.

## Filesystem

### Paths

Filesystem paths are literal and do not support glob syntax. They may be
absolute, relative to the workspace, or start with `~/`.

Permissions apply to a configured path and its descendants. Paths are matched
after resolving symlink redirections to their canonical targets, so a deny
rule also applies through aliases to the same target. An allow rule cannot
grant access outside its configured path boundary.

### Read

Reads are allowed by default.

- `denyRead` denies reading the configured paths.
- `allowRead` restores read access within denied paths.

When several read rules match, the most specific path takes precedence. An
allow rule wins when allow and deny rules have equal specificity.

### Write

Writes are denied by default.

- `allowWrite` allows writing to the configured paths.
- `denyWrite` denies writing to the configured paths.

A write requires a matching allow rule. Any matching deny rule takes
precedence over all allow rules, regardless of specificity.

## One-time Exceptions

Escalation asks the user to authorize one operation beyond the current policy.
Depending on the operation, escalation may happen automatically on a policy
violation or must be requested explicitly.

Use escalation sparingly. Frequent approval requests interrupt and annoy the
user. Prefer an already-permitted way to finish the task, but never circumvent
policy or a user rejection through another tool.

Approval applies only to the specific request shown to the user. A retry or a
request with different inputs requires another approval. Approval cannot
authorize an invalid, unresolved, cancelled, or execution-unsafe request; it
does not change policy and is never remembered or replayed. Escalation is
available only in Pi's interactive TUI. If it is unavailable or rejected, the
operation remains denied.

## Update Policy

To update the policy:
- Request user's permission
- Update workspace policy config (or global if explicitly requested by user)
- Ask user to call `/reload` to let new policy take into effect.

For recurring needs, request a narrowly scoped persistent change rather than
repeated approvals. An `allowWrite` addition cannot defeat a matching
`denyWrite`: deliberately review the applicable deny rules too, rather than
silently appending a broader allow.

The current schema is filesystem-only and does not apply to bash. 

Policy schema is located at `mikoto-policy.schema.json` in the same directory as this markdown file. Only
read it if you attempt to update policy.
