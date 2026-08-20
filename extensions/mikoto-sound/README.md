# Mikoto Sound

Mikoto Sound is a macOS-only Pi extension that plays non-blocking sound effects
for Pi lifecycle events and requests from other extensions.

It plays the bundled `completed` effect whenever Pi emits `agent_settled`.
Other extensions can request a sound through the shared event bus:

```ts
import type { MikotoEventEmitter } from "mikoto-types";

const events: MikotoEventEmitter = pi.events;
events.emit("mikoto-sound:sound", {
  effect: "require-attention",
});
```

An empty payload object selects `require-attention`. There is deliberately no
callback or acknowledgement: emitting remains safe when Mikoto Sound is not
loaded. Unknown or malformed effects are ignored with a warning.

On operating systems other than macOS, the extension registers nothing and is
a silent no-op.

## Bundled effects

| Effect | File |
| --- | --- |
| `require-attention` | `resources/bip-bop-03.mp3` |
| `completed` | `resources/bip-bop-01.mp3` |

## Configuration

The optional config file is:

```text
~/.pi/agent/mikoto-sound.json
```

Example:

```json
{
  "effects": {
    "completed": "~/Sounds/completed.aiff",
    "custom-effect": "sounds/custom.wav"
  }
}
```

Absolute paths are used directly, `~` is expanded, and relative paths resolve
from the directory containing `mikoto-sound.json` (normally
`~/.pi/agent`). Valid entries add effects or override bundled names.

Configured files must be readable regular audio files accepted by
`/usr/bin/afinfo -b`. Any format supported by macOS `afinfo`/`afplay` is
allowed. Configuration is strict and atomic: an unknown field, invalid mapping,
or unusable file rejects all overrides and keeps the complete bundled map.
Config edits take effect after `/reload` or a new session.

Mikoto Sound uses Zod 4 for runtime validation of config and event payloads.
The shared `mikoto-types` package remains declaration-only and has no Zod
dependency.

Configuration and playback problems are written to stderr and recorded as
UI-only branch warnings. They are never added to model context.

## Playback

Mikoto Sound starts `/usr/bin/afplay` without a shell, detaches it, and returns
immediately. Sound requests do not block Pi, and concurrent effects may
overlap.

## Install

```bash
pi install /absolute/path/to/mikoto-harness/extensions/mikoto-sound
```

Or test from the Mikoto Harness root:

```bash
pi -e ./extensions/mikoto-sound
```

## Development

Install workspace dependencies from the Mikoto Harness root, then validate only
this package:

```bash
npm install
npm run validate -w mikoto-sound
```

From this package directory, `npm run validate` is also supported.
