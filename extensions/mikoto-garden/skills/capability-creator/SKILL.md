---
name: capability-creator
description: Create a Pi extension that exposes a secure, narrow host capability to exec_command shell workloads and bundles a skill showing how to call it. Use for constrained host-side integrations such as stateful services, delegated authentication, or operations unavailable inside the sandbox.
---

# Create a Garden capability

Garden is the managed command-execution layer that provides `exec_command`.
Commands run in a sandbox, but each command receives an authenticated,
session-scoped capability-server endpoint when that service is available.
Other Pi extensions can bind narrow host-authority operations to routes on that
server. An `exec_command` shell can then call an approved route without moving
the entire command outside the sandbox.

Capabilities are useful for narrowly exposing an operation unavailable inside
the sandbox, maintaining host-side state across shell calls, or keeping an
authentication flow and its credentials outside workloads. In each case,
expose only the required operation, validate its input, and keep all other host
authority unavailable. A capability is not a generic sandbox escape or a
separate strong isolation boundary; every command holding the session token
can call every installed route.

## Decide whether a capability is needed

Prefer the simpler design. If the requested operation can be expressed entirely
as instructions or a script run by `exec_command`, and its filesystem and
network access are already allowed by Mikoto Policy, create or update a normal
skill instead. Do not add a host capability merely to wrap a CLI that works
correctly inside the sandbox.

Create a capability when a narrow host-side boundary adds something the
sandboxed skill cannot provide, such as retained service state, isolated
credentials or delegated authentication, or a deliberately constrained
operation outside the sandbox. Do not broaden Policy simply to avoid designing
a host boundary when the operation should remain host-side.

Create one Pi package containing:

1. a Pi extension that binds one or more narrow HTTP routes to Garden; and
2. a capability-specific skill that teaches `exec_command` workloads how to
   call those routes.

Do not add the capability directly to Garden. Garden owns the authenticated
server and routing boundary; the new extension owns its host operation and
usage skill.

## Read an example and the contract

Read `../../../mikoto-terminal-notify/index.ts` first when it exists in the
source workspace; otherwise locate the installed `mikoto-terminal-notify`
package and read its `index.ts`. It is the minimal reference capability: one
extension file binds a text route, validates input, keeps a small amount of
state, delivers a host-side UI action, handles binding acknowledgement, and
disposes the route at shutdown.

If that extension is unavailable, use `../../examples/binding.ts` as the basic
binding example. Read `../../README.md` for the public capability contract.
Reading `../../src/capability-registry.ts` and
`../../src/capability-server.ts` is optional; inspect them only when exact
routing, HTTP, lifecycle, or limit behavior matters to the requested design.

Also read the target repository's instructions and its inter-extension
guidance. Locate the exact `mikoto-types` checkout used by Garden and inspect
the `MikotoGardenBindEvent` and `MikotoEventEmitter` declarations. Supported
producers must use that same checkout and the typed emitter; do not copy the
event contract or call `pi.events.emit()` directly.

## Choose the location

Honor a location or loading scope specified by the user.

When the user does not specify either, do not ask only about placement. Create
a project-local Pi package at:

```text
<workspace>/.pi/packages/<extension-name>/
```

Treat Pi's current working directory as `<workspace>` unless repository
instructions identify another root. Add the local package to
`<workspace>/.pi/settings.json` after Policy and Garden, preserving all existing
settings. A source at the default location is written as
`./packages/<extension-name>` because package paths are relative to the settings
file. Do not modify global Pi settings for the default.

Load the package **directory**, not only its `index.ts`, so Pi follows the
manifest and discovers the bundled skill. Project-local settings require
project trust. Tell the user whether `/reload` is sufficient or whether a new
trusted Pi session is required.

## Define the capability before coding

Establish these details from the request, asking only when behavior cannot be
inferred safely:

- a canonical route and `GET` or `POST` method;
- a bounded Zod 4 input schema;
- the exact host-side operation and its permitted scope;
- the response status, body, and content type;
- cancellation and timeout behavior; and
- the name and intended trigger for the bundled usage skill.

Routes are exact and have no query API. A path is at most 256 characters, uses
only ASCII letters, digits, `_`, `.`, `~`, `-`, and `/`-separated segments, and
contains no `.` or `..` segment. Choose a method/path pair that no loaded
extension already owns; `POST /update` is conventionally owned by
`mikoto-terminal-notify` when that extension is loaded.

Every holder of a session's Garden token can call every installed route. There
is no route-specific approval, per-command identity, or caller allowlist.
Handlers run in Pi's host process with host authority. Never expose a generic
shell, arbitrary filesystem access, arbitrary URL forwarding, credential
retrieval, or another user-selected host primitive. If the requested design
has that shape, stop and narrow it to explicit operations and allowlists before
implementing it.

## Package layout

Follow stricter target-repository conventions when present. Otherwise create:

```text
<extension-name>/
├── index.ts
├── skills/
│   └── <capability-skill>/
│       └── SKILL.md
├── package.json
└── tsconfig.json
```

Keep a small capability's complete implementation in the root `index.ts`, as
`mikoto-terminal-notify` does. Split out modules only when the host operation
has enough independent logic to justify them. The package manifest must load
both resources:

```json
{
  "pi": {
    "extensions": ["./index.ts"],
    "skills": ["./skills"]
  }
}
```

Put Zod 4 in `dependencies`. Put Pi packages imported only for types in
`peerDependencies` and development tooling in `devDependencies`, following the
target repository. Resolve `mikoto-types` to the exact source used by Garden;
its package version is not a compatibility signal. If that exact contract
cannot be resolved, stop and explain the mismatch instead of using an untyped
event.

Capability skill names must be specific to the operation and contain no Mikoto
branding. Keep the authored `SKILL.md` inside this package; do not generate or
copy it during build.

## Bind the route

Emit `mikoto-garden:bind` from `session_start` or later, never during the
extension factory. Garden must load before the capability extension because
event-bus messages are not queued or replayed.

Adapt the structure in `mikoto-terminal-notify/index.ts` rather than inventing
a second integration pattern. In particular:

- assign `pi.events` to `MikotoEventEmitter` and use its typed
  `mikoto-garden:bind` overload;
- keep registration state separate from handler state;
- provide a bounded Zod schema and let its output infer the handler body type;
- check the handler's abort signal and pass it to abort-aware host APIs;
- accept at most one successful acknowledgement and immediately dispose
  duplicate successful bindings;
- report an unavailable or rejected binding without throwing from startup; and
- dispose the accepted binding on shutdown.

A successful binding means the route was registered; it does not prove that
Garden's optional HTTP listener is currently available.

The current Garden receiver acknowledges synchronously. If the target
environment requires asynchronous or replaceable receivers, use a bounded
producer-local acknowledgement helper that handles no receiver, duplicate
callbacks, cancellation, and late success without leaking a binding.

### Request and response rules

- `POST` defaults to JSON and requires `Content-Type: application/json`
  (optionally with UTF-8 charset). Use `bodyFormat: "text"` only for deliberate
  raw UTF-8 input.
- `GET` accepts no request body and should use `z.undefined()`.
- Zod's parsed output, including defaults and transforms, is the handler's
  `body`. Keep schemas bounded, strict where appropriate, and side-effect-free.
- Pass `signal` to abort-aware host APIs and check it around non-abort-aware
  work. Cancellation and timeout are cooperative, not rollback.
- Return 2xx, 4xx, or 5xx; redirects are rejected. Status 204 and 205 cannot
  have a body.
- Response bodies are UTF-8 strings capped at 64 KiB. Optional response headers
  are limited to lowercase `content-type` and `cache-control`.
- Requests have roughly five-second bounds. Timed-out schema or handler work
  retains a concurrency slot until it settles, so never leave work floating.
- Do not return exception details, host paths, credentials, or sensitive
  internal state to the caller.

## Write the bundled usage skill

The capability-specific `SKILL.md` must have valid `name` and `description`
frontmatter and explain exactly when the capability should be used. Document:

- required `GARDEN_SERVER` and `GARDEN_TOKEN` variables;
- the exact method, route, request shape, and response;
- one safe copyable client example using literal environment-variable
  references;
- expected unavailable, validation, and operation failures; and
- any operation-specific privacy or authorization limits.

For curl, disable user configuration, use a short timeout, send the bearer
header, set the correct content type, and do not follow redirects. For example:

```sh
[ -n "${GARDEN_SERVER:-}" ] && [ -n "${GARDEN_TOKEN:-}" ] || exit 1
curl --disable --silent --show-error --fail --max-time 5 \
  --header "Authorization: Bearer $GARDEN_TOKEN" \
  --header "Content-Type: application/json" \
  --data-binary '{"value":"example"}' \
  "$GARDEN_SERVER/example"
```

Tailor the example to the actual schema. Do not interpolate untrusted text into
shell-built JSON; use a safe serializer in Python, Node.js, or another available
client when values are dynamic.

The usage skill must tell agents:

- never print, persist, trace, or recover the bearer token;
- never use `/ps:debug` to obtain credentials for the model;
- never use `--noproxy`, raw loopback aliases, escalation, or policy widening
  merely to reach the capability;
- never retry authentication, availability, or rate-limit failures in a loop;
  and
- keep ordinary tool output as the authoritative record.

Sandboxed commands use Garden's normal proxy path. Native Node `fetch` needs
the tested `--use-env-proxy` opt-in. A missing variable or HTTP 401, 404, 405,
413, 415, 429, 500, 503, or 504 must be handled as an ordinary unavailable or
failed capability, without guessing endpoints or tokens.

## Validate

Before reporting completion:

1. Type-check the extension and verify it imports the typed event contract.
2. Test valid input, schema rejection, operation failure, cancellation, and
   bounded output without exposing host-sensitive details.
3. Verify duplicate/no receiver behavior and idempotent shutdown disposal.
4. Verify the package manifest discovers both the extension and bundled skill;
   inspect packed files if the package will be distributed.
5. Check the project settings preserve prior resources and load Policy, Garden,
   then the capability package.
6. Run formatting and whitespace checks required by the target repository.

Do not broaden Policy, disable Garden isolation, make paid model requests, or
expose the bearer token to test the capability. For an end-to-end check, reload
Pi and invoke the route from a normal sandboxed `exec_command` using the bundled
usage skill.
