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

## Bind the route

Follow `../../examples/binding.ts` and these binding rules:

- Import `MikotoEventEmitter` from the exact `mikoto-types` checkout used by
  Garden and use its typed `mikoto-garden:bind` overload. Do not copy the event
  contract or call `pi.events.emit()` directly.
- Emit `mikoto-garden:bind` from `session_start` or later with a non-empty
  `owner`. The only methods are `GET` and `POST`, and each method/path pair must
  be unique.
- Paths are exact, have no query API, and are at most 256 characters. Use
  `/`-separated segments containing only ASCII letters, digits, `_`, `.`, `~`,
  and `-`; `.` and `..` segments are forbidden.
- Request bodies are limited to 16 KiB and must have a bounded Zod 4 schema.
  `GET` has no body and uses `z.undefined()`. `POST` defaults to JSON; set
  `bodyFormat: "text"` only for raw UTF-8 text.
- Handlers receive the schema's parsed output and an `AbortSignal`. Observe the
  signal, finish within the 60-second request deadline, and do not
  leave work floating.
- Return a 2xx, 4xx, or 5xx status. Response bodies are UTF-8 strings limited
  to 100 MiB; 204 and 205 responses have no body. The only supported response
  headers are lowercase `content-type` and `cache-control`.
- Every command with the session token can call every binding, and handlers run
  with host authority. Bind only narrow operations; never expose a generic
  shell, arbitrary filesystem access, arbitrary URL forwarding, or credential
  retrieval.

## Write the bundled usage skill

Use `SKILL.template.md` as the template for the capability-specific `SKILL.md`.

## Validate

In addition to normal Pi extension validation, test the binding's:

- valid request and declared response;
- schema rejection and request/response size boundaries;
- operation failure and cancellation; and
- responses for accidental host-sensitive details.
