# Mikoto Policy

Mikoto Policy is a Pi extension that enforces filesystem permissions for Pi's
native file tools and exposes a policy API to dependent extensions in Mikoto
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

Native tool calls to `read`, `grep`, `find`, `ls`, `write`, and `edit` are
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

For Pi's native tools, Mikoto Policy currently bridges target determination to
execution by replacing the lexical tool argument with the approved canonical
path.

Pi's built-in file tools still use ordinary pathname-based filesystem
operations. A concurrent actor can therefore introduce a symlink into the
pinned canonical path between target determination and tool execution.

`bash` is not enforced in this extension and it should be enforced in other
extensions.

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

### Get the Policy Object

- Users must place `mikoto-policy` before every dependent extension in Pi's
  configured extension load order. `mikoto-policy` must be loaded first; merely
  installing it is not sufficient.
- Consumers must emit the request from their `session_start` handler
  (recommended) or later, never from their extension factory. Pi awaits
  `session_start` handlers in extension load order, so loading `mikoto-policy`
  first ensures its policy object is initialized before a dependent extension
  requests it.
- The returned `MikotoPolicy` and its document are immutable session-scoped
  snapshots of the loader's pinned canonical policy, not live-updating
  objects. Request the policy during every `session_start` and cache it for
  that session. Use `/reload` to resolve policy paths again.
- Consumers must use `MikotoEventEmitter` from the same `mikoto-types` commit
  as the policy extension. See
  [`inter-extensions.md`](../../docs/inter-extensions.md).

### Handle Symlinks During Filesystem Authorization

Consumers must preserve the same target through all three authorization
stages:

1. **Target determination:** Resolve the tool input to a lexical path, then
   resolve and pin its canonical path. `resolveToolPath()` provides an absolute
   lexical path in the session context, while `canonicalizePath()` performs
   lexical-to-canonical resolution. "Pinning" stores that current resolution
   decision so tool execution or commit uses the canonical path selected in
   this step instead of resolving the lexical path again. Treat either
   preparation failure as denial.
2. **Policy evaluation:** Pass only the pinned canonical path to
   `evaluateRead()`, `evaluateReadTree()`, or `evaluateWrite()`. These methods
   accept normalized absolute canonical paths, do not inspect the filesystem,
   and do not resolve or verify symlinks.
3. **Tool execution or commit:** If policy allows the operation, execute it
   against the exact canonical path that was evaluated. Tool execution or
   commit must ensure that the resolved canonical path is still canonical. A
   robust implementation can use descriptor-relative no-follow traversal on
   Unix or no-reparse handle opens on Windows; alternatively, it can check that
   the path is still canonical immediately before applying the operation and
   accept the small resulting TOCTOU risk.

The basic flow is:

```ts
const lexicalPath = policy.resolveToolPath("./src/index.ts");
const canonicalPath = await policy.canonicalizePath(lexicalPath);
const decision = await policy.evaluateRead(canonicalPath);

if (decision.allowed) {
  // Execute against canonicalPath, never lexicalPath.
}
```

A tool with its own planning layer may perform target determination itself and
evaluate the canonical paths pinned by its plan. Its execution or commit stage
must consume that same plan so it cannot return to the lexical paths after
approval.

## Development

From the Mikoto Harness root:

```bash
npm run validate -w mikoto-policy
```
