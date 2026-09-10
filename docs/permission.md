# Building permission-aware extensions

Mikoto Policy provides two related services to other extensions:

1. a session-scoped snapshot for evaluating filesystem access; and
2. a TUI decision broker for requesting a one-operation exception.

The services are independent. An extension may evaluate filesystem policy
without escalating, escalate automatically after a denial, or require an
explicit escalation mode for an operation such as unsandboxed execution.

## Prerequisites

- Load `mikoto-policy` before every extension that consumes it.
- Use `MikotoEventEmitter` and related declarations from the same
  `mikoto-types` commit as Policy.
- Keep `mikoto-types` declaration-only and import from it with `import type`.
- Follow the generic event-bus conventions in
  [inter-extensions.md](inter-extensions.md).

## Obtain the policy snapshot

Request the policy during every `session_start` and cache it only for that
session:

```ts
import type {
  MikotoEventEmitter,
  MikotoPolicy,
} from "mikoto-types";

let policy: MikotoPolicy | undefined;
let lifetime = new AbortController();
const events: MikotoEventEmitter = pi.events;

pi.on("session_start", () => {
  lifetime.abort();
  lifetime = new AbortController();
  policy = undefined;
  const currentLifetime = lifetime;

  events.emit("mikoto-policy:get-policy", {
    callback(currentPolicy) {
      if (lifetime === currentLifetime && !lifetime.signal.aborted) {
        policy ??= currentPolicy;
      }
    },
  });
});

pi.on("session_shutdown", () => {
  lifetime.abort();
  policy = undefined;
});

pi.on("session_tree", () => {
  lifetime.abort();
  lifetime = new AbortController();
});
```

Policy does not replay requests. Emitting before Policy's `session_start`
handler has initialized the snapshot produces no callback, which is why
Policy-first extension load order is required.

The returned object and its document are immutable, pinned snapshots. Obtain a
new one after reload or session replacement rather than retaining an old
reference. A consumer must explicitly decide and document what absence of a
Policy provider means. If a provider was found and later denies an operation,
failure to obtain escalation must remain a denial.

## Authorize filesystem access

Keep target determination, policy evaluation, and execution aligned:

```ts
const lexicalPath = policy.resolveToolPath(input.path);
const canonicalPath = await policy.canonicalizePath(lexicalPath);
const decision = await policy.evaluateWrite(canonicalPath);

if (decision.allowed) {
  // Execute against canonicalPath, never input.path.
}
```

Use `evaluateRead()` for one file, `evaluateReadTree()` for directory
enumeration, and `evaluateWrite()` for writes. These evaluation methods accept
normalized absolute canonical paths and do not resolve symlinks themselves.

For operations with several targets, determine and evaluate every distinct
target before content reads, planning, or mutation. Keep the prepared
operation immutable while authorization is pending, and execute that same
prepared operation after approval.

Approval can take an arbitrary amount of time. Recheck cancellation, runtime
lifetime, and the target's canonical identity immediately before access or
commit. Prefer descriptor-relative no-follow traversal where available.
Ordinary pathname rechecks reduce races but do not eliminate TOCTOU.

Invalid input, target-resolution failure, policy-evaluation failure,
cancellation, and execution-safety failure are denials, not opportunities to
ask the user to override broken preparation.

## Request a one-operation exception

An extension owns the trigger for escalation:

- an automatic trigger may ask after a policy denial; and
- an explicit trigger may require a validated public tool argument before
  asking.

Validate public arguments before requesting escalation. Freeze all
authorization-relevant inputs, then emit `mikoto-policy:escalate` during the
initialized operation with its current `AbortSignal`.

The event contains:

- `requestId`: the originating operation or tool-call ID;
- `source`: the extension shown to the user;
- `verb`: a concise description of the requested action;
- `subject`: the complete scope as a string or list of strings;
- `why`: an honest justification;
- `signal`: the current operation's cancellation signal;
- `claim()`: synchronous first-receiver ownership; and
- `callback()`: the one-shot decision result.

Use a producer-local helper implementing this protocol:

1. Install the abort listener before emitting.
2. Permit `claim()` only synchronously while `emit()` is dispatching.
3. Resolve `unavailable` immediately if no receiver claims.
4. Accept only the first callback and ignore duplicate or late callbacks.
5. Do not accept synchronous approval until `emit()` returns normally. A
   receiver can invoke the callback and then throw.
6. Treat dispatch failure, cancellation, and every non-approval result as
   denial.
7. Remove listeners when settled and recheck cancellation and runtime
   lifetime before execution.

[Apply Patch's policy bridge](../extensions/mikoto-apply-patch/src/policy.ts)
is the reference producer implementation. Keep the helper producer-local;
Policy's event is an in-process contract, not a runtime utility library,
serializable RPC, or permission token.

The first synchronous claimant wins in event-listener order. This is delivery
ownership, not agreement among several policy providers. The claimant must
eventually invoke the callback even when it is uninitialized, non-interactive,
busy, shutting down, or failing internally.

## Decision semantics

Results are either `approve` or `reject`. Rejection causes distinguish user
rejection, interruption, cancellation, non-interactive execution, unavailable
receivers, broker capacity, shutdown, and internal error. Only user rejection
may include a reason.

Approval applies only to the exact request shown to the user. A retry or any
change to authorization-relevant input needs another decision. Approval does
not update policy, survive reload, authorize future operations, or prove that
execution succeeded.

Escalation is available only in Pi's interactive TUI. Other modes reject it.
Policy serializes its own dialogs, but there is no cross-extension modal
coordinator; do not request escalation from inside another blocking custom
dialog.

The broker records informational session entries. Never inspect restored
history as authorization. Persisted entries, public tool arguments, config,
JSON, and network input remain untrusted boundaries and require runtime
validation. Garden's private executor IPC couples two trusted components of one
package; shared contracts, bounds, operation identity, and lifecycle checks
catch mismatched builds and stale messages rather than authenticating an
untrusted peer. The Mikoto event payload itself follows the trusted,
same-commit convention from [inter-extensions.md](inter-extensions.md).

## Model guidance

Keep global permission guidance generic so it remains correct as extensions
are added. A tool that requires explicit escalation must describe that trigger
in its own public schema or tool instructions. Do not advertise unsupported
arguments on other tools.

Policy's Permissions block owns the effective filesystem **and network**
snapshot, with network enforcement explicitly scoped to sandboxed Garden
commands. Garden's short execution block refers to that section rather than
duplicating policy JSON; capability workflows belong in bundled, on-demand
skills. Describe the live capability endpoint exception symbolically, never
by injecting its address or bearer token.

Escalation interrupts the user. Encourage the model to work within current
permissions and request exceptions infrequently, without suggesting a bypass
through another tool.

## Testing checklist

Test the behavior owned by the consumer:

- provider present and absent;
- allowed operation without a dialog;
- automatic or explicit escalation trigger;
- approval, user rejection with and without reason, and unavailable broker;
- cancellation before emission, while waiting, and racing approval;
- duplicate listeners, duplicate callbacks, late claims, and dispatch throws;
- reload, shutdown, session replacement, and tree-navigation invalidation;
- immutable operation inputs and canonical-target changes while waiting;
- every non-TUI mode; and
- execution of the same prepared operation only after authorization.

Garden additionally requires `policy.diagnostics()` and rejects invalid or
unreadable selected layers and failed canonical rules, even when native file
evaluation retains its existing fallback snapshot. Optional absence and
untrusted-workspace skipping are benign. Its network document remains pinned;
the ephemeral capability endpoint exception belongs to Garden, not Policy.

Run TypeScript checks for the consumer, `mikoto-policy`, and `mikoto-types`.
For UI or lifecycle changes, also perform a real Pi TUI smoke test.
