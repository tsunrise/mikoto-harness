# Mikoto Policy

A Mikoto policy describes permitted and denied operations.

The optional `$schema` field identifies the JSON Schema used to validate and
edit the policy document. It does not grant or deny permissions.

## Policy layers

Policy is loaded from these layers, from lowest to highest precedence:

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

Permissions apply to a configured path and its descendants. Paths are
evaluated after resolving symlinks. A deny rule therefore applies through
aliases to the same target. An allow rule cannot grant access outside its
configured path boundary.

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
