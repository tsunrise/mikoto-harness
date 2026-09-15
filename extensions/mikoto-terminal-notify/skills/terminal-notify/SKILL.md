---
name: terminal-notify
description: Send a UI notification from an exec_command workload. Use only when the user explicitly requests notifications, for worthwhile updates from a background task expected to exceed 10 minutes, or for meaningful events from a long-running daemon.
---

# Terminal notifications

This capability lets an `exec_command` workload send a short, best-effort
notification to Pi's UI through the authenticated `POST /update` route. It is
intended for meaningful progress updates from work that continues in the
background.

## Precondition

Use this skill only when at least one of these conditions applies:

- The user explicitly requested notifications.
- A real background task is expected to run for more than 10 minutes and has
  a meaningful intermediate update worth interrupting the user for.
- A long-running daemon has a meaningful event worth bringing to the user's
  attention.

A command does not qualify merely because it yielded after the default 10-second
foreground wait, and a routine task expected to finish within 10 minutes does
not qualify without an explicit user request. Do not load or invoke this skill
speculatively. Do not notify for every command, loop iteration, or log line.
Ordinary background completion already has a UI notification; avoid duplicating
it.

## Capability API

The capability server endpoint is provided in the `GARDEN_SERVER` environment
variable and authenticated with the bearer token in the `GARDEN_TOKEN`
environment variable. The built-in proxy is enabled automatically through
environment variables for curl, Python, and Node.js, so no manual proxy
configuration is needed.

### `POST /update`

Sends a notification to Pi's UI.

- **Headers:** `Content-Type: text/plain; charset=utf-8`.
- **Body:** Plain UTF-8 text, not JSON. Prefer fewer than 500 characters; the
  hard limit is 16 KiB. Do not include credentials or sensitive task output.
- **Response:** `204 No Content` means delivery was accepted, not that the user
  read the notification. `429` indicates rate limiting, and `503` indicates
  that the UI is unavailable. Treat failures as best-effort and do not retry
  them in a loop.

```sh
curl --disable --silent --show-error --fail --max-time 5 --output /dev/null \
  --header "Authorization: Bearer $GARDEN_TOKEN" \
  --header "Content-Type: text/plain; charset=utf-8" \
  --data-binary 'Preview assets are ready; integration tests are still running.' \
  "$GARDEN_SERVER/update"
```
