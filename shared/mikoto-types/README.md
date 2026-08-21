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

Any event emitted to a `mikoto-*` channel **must** be type-checked through
`MikotoEventEmitter`, and all participating extensions must use
`mikoto-types` from the same exact commit. `mikoto-types` does **not** use
SemVer: the `version` field in `package.json` is not a compatibility signal,
and every commit is a different version. Otherwise, behavior is undefined.

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
