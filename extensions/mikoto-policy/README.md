# Mikoto Policy

Mikoto Policy is a Pi extension that provides permission control native tools and
all other extensions in Mikoto Harness.

## Configuration

See [PERMISSION.md](PERMISSION.md) for policy semantics.

Run `/mikoto-policy:view` to display the active config paths and merged policy.
Policy changes take effect after `/reload`.

The JSON Schema is available at
[mikoto-policy.schema.json](mikoto-policy.schema.json).

## Behavior

Native tool calls to `read`, `grep`, `find`, `ls`, `write`, and `edit` are
enforced according to the configured policy.

`bash` is not enforced in this extension and it should be enforced in other extensions.

## Inter-extension API

The `mikoto-policy:get-policy` event obtains the current session-scoped policy:

```ts
import type {
  MikotoEventEmitter,
  MikotoPolicy,
} from "mikoto-types";

let policy: MikotoPolicy | undefined;
const events: MikotoEventEmitter = pi.events;

pi.on("session_start", () => {
  events.emit("mikoto-policy:get-policy", {
    callback(currentPolicy) {
      policy = currentPolicy;
    },
  });
});
```

- User MUST configure `mikoto-policy` **before** dependent extensions. 
- Consumers **must** emit the request from their `session_start` handler (recommended) or later, never from their extension
factory. Pi awaits `session_start` handlers in extension load order, which guarantees a later extension 
to observe the `events.on` from `mikoto-policy`.
- The returned `MikotoPolicy` and its document are immutable.
- Evaluation methods accept absolute lexical paths. Use `resolveToolPath()` to
convert a possibly relative Pi tool path against the policy's session working
directory:

```ts
const absolutePath = policy.resolveToolPath("./src/index.ts");
const decision = await policy.evaluateRead(absolutePath);
```

- Consumers receive a session-scoped snapshot, not a live-updating object, and
must request it again after session replacement or `/reload`.
Consumers are **advised** to request the policy during every `session_start` and
cache the returned object for the rest of that session so they receive each
policy update.

- Consumers must use `MikotoEventEmitter` from the same `mikoto-types` commit as
the policy extension. See [`inter-extensions.md`](../../docs/inter-extensions.md)

## Development

From the Mikoto Harness root:

```bash
npm run validate -w mikoto-policy
```
