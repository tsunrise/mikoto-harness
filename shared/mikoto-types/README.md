# Mikoto Types

Mikoto Types is a declaration-only package containing compile-time contracts
for communication between Mikoto Pi extensions.

It exports no JavaScript and is not a Pi extension. Producers can use the
typed emitter view:

```ts
import type { MikotoEventEmitter } from "mikoto-types";

const events: MikotoEventEmitter = pi.events;
events.emit("mikoto-sound:sound", {
  effect: "require-attention",
});
```

Pi's runtime event bus accepts `unknown`. Consumers must still validate event
payloads at runtime instead of trusting these declarations.

## Development

From the Mikoto Harness root:

```bash
npm install
npm run validate -w mikoto-types
```

Or from this package directory:

```bash
npm run validate
```
