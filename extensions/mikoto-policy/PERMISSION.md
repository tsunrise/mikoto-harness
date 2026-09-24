# Mikoto Policy

A Mikoto policy describes permitted and denied operations.

## Policy Locations

Policy is loaded from these locations, from lowest to highest precedence:

1. The bundled `mikoto-policy.default.json`.
2. `mikoto-policy.json` in the Pi agent directory.
3. `mikoto-policy.json` in the trusted workspace root.

Filesystem/network fields inherit independently. Arrays may either be replaced
with a plain array or changed with a delta object:

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
value from the previous layer. Escalation settings use the atomic boundaries
described below, not recursive agent-object merging.

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

Escalation authorizes one operation beyond the current policy using the user's
configured decision strategy.
Depending on the operation, escalation may happen automatically on a policy
violation or must be requested explicitly.

Use escalation sparingly. Frequent approval requests interrupt and annoy the
user. Prefer an already-permitted way to finish the task, but never circumvent
policy or a user rejection through another tool.

Approval applies only to the exact prepared request. A retry or a
request with different inputs requires another approval. Approval cannot
authorize an invalid, unresolved, cancelled, or execution-unsafe request; it
does not change policy and is never remembered or replayed. If escalation is
unavailable or rejected, the operation remains denied. 

User may opt in using a model to review your escalation automatically. The reviewer 
model would have access to the recent transcript. 

## Update Policy

To update the policy:
- Request user's permission
- Update workspace policy config (or global if explicitly requested by user)
- Ask user to call `/reload` to let new policy take into effect.

For recurring needs, request a narrowly scoped persistent change rather than
repeated approvals. An `allowWrite` addition cannot defeat a matching
`denyWrite`: deliberately review the applicable deny rules too, rather than
silently appending a broader allow.

## Network

The strict schema also accepts:

```json
{
  "network": {
    "allowedDomains": ["api.example.com:443", "*.example.org"],
    "deniedDomains": ["private.example.org"]
  }
}
```

Both arrays default to empty and support replacement and `+`/`-` deltas.
Entries are normalized to lowercase before deltas. Supported destinations
are ASCII DNS/punycode names, `*.example.com` (subdomains, not the apex), and
canonical dotted-decimal IPv4. Each may have a decimal `:port` from 1–65535.
Only denies accept `*` and `*:port`. URLs, paths, userinfo, CIDR, IPv6,
noncanonical numeric addresses, and other globs are rejected.

Network access requires an explicit matching allow. A matching deny takes
precedence over every allow, and unmatched destinations remain denied. Network
decisions do not open an approval dialog.

### Local IPC

Domain rules only govern proxied traffic. Clients such as database drivers and
the Docker CLI connect directly to loopback ports or Unix sockets, which need
separate grants:

```json
{
  "network": {
    "allowLocalBinding": true,
    "allowUnixSockets": ["~/.docker/run/docker.sock"]
  }
}
```

- `allowLocalBinding` (default `false`, replaced by later layers) permits
  direct connections to every localhost TCP port and local bind/listen.
  Domain rules, including `deniedDomains`, do not apply to these connections.
- `allowUnixSockets` (default empty) lists socket paths, following the same
  path syntax and `+`/`-` deltas as filesystem rules. Each path grants itself
  and its descendants. Symlinks resolve to their canonical target, and
  unresolvable entries are dropped with a `canonical_rule` diagnostic.

Granting a container-runtime socket such as Docker's effectively grants host
access, because containers can mount arbitrary host paths.

`policy.diagnostics()` distinguishes invalid/unreadable selected layers and
dropped canonical rules from optional absence or an untrusted workspace.
Editing policy still requires separate user authorization and `/reload`.

Policy schema is located at `mikoto-policy.schema.json` in the same directory as this markdown file. Only
read it if you attempt to update policy.
