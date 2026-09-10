---
name: terminal-notify
description: Send a UI notification from an exec_command workload. Use only when the user explicitly requests notifications, for worthwhile updates from a background task expected to exceed 10 minutes, or for meaningful events from a long-running daemon.
---

# Terminal notifications

Use this skill only when at least one of these conditions applies:

- The user explicitly requested notifications.
- A real background task is expected to run for more than 10 minutes and has
  a meaningful intermediate update worth interrupting the user for.
- A long-running daemon has a meaningful event worth bringing to the user's
  attention.

A command does not qualify merely because it yielded after Garden's default
10-second foreground wait, and a routine task expected to finish within 10
minutes does not qualify without an explicit user request. Do not load or invoke
this skill speculatively. Do not notify for every command, loop iteration, or
log line. Ordinary background completion already has a UI notification; avoid
duplicating it.

## Send from the workload

Commands receive `GARDEN_SERVER` and `GARDEN_TOKEN` when capabilities are
available. The following is one possible shell helper. Adapt it freely, call
the route directly, or use another suitable client such as Python or Node.js.
If using a shell function, define it in the command source or task script where
it is needed because each `exec_command` starts a fresh shell.

```sh
notify_progress() {
  [ -n "${GARDEN_SERVER:-}" ] && [ -n "${GARDEN_TOKEN:-}" ] || return 0
  printf '%s' "$1" |
    curl --disable --silent --fail --max-time 5 --output /dev/null \
      --header "Authorization: Bearer $GARDEN_TOKEN" \
      --data-binary @- "$GARDEN_SERVER/update" || :
}
```

For example, a task with two phases could use it like this:

```sh
run_phase_one &&
  { notify_progress 'Preview assets are ready; integration tests are still running.'
    run_phase_two
  }
```

Launch through normal sandboxed `exec_command`; let it yield a session ID if
still running. Send the notification **after the milestone actually succeeds**,
not when starting it. The helper is best-effort: a missing/stale capability or
failed notification does not change the task's outcome. Keep normal tool output
as the authoritative record; do not claim confirmed delivery from this helper.

## Boundaries

- `POST $GARDEN_SERVER/update` accepts a plain UTF-8 message, not a JSON
  envelope. Keep it short (preferably under 500 characters; hard limit 16 KiB),
  specific, and free of credentials or sensitive task output.
- Keep the bearer token out of model context and logs. Never print it, use
  shell tracing or verbose curl, copy it into tool arguments, or persist it.
  Reference the variable literally in shell source. Do not fetch it from
  `/ps:debug` or inspect unrelated processes/files to recover it.
- Keep normal proxy handling inside the sandbox. Do not use `--noproxy`,
  disable sandboxing, request escalation, widen policy, or guess another
  address/token just to deliver a notification. Do not follow redirects.
- HTTP 204 means the UI delivery request was accepted, not that a person read
  it. Notifications neither add model context nor start an agent turn.
  Print/JSON mode has no notification UI; RPC requires a client that displays
  notification requests.
- Missing variables, 401, 429, 503, or connection failure mean unavailable,
  stale, rate-limited, or undeliverable service. Do not retry in a loop.
  Continue the task and report important results normally.
