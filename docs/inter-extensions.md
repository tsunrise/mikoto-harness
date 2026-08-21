# Inter-extension communication

Mikoto extensions communicate through Pi's shared in-process event bus:

```ts
pi.events.on(channel, receiver);
pi.events.emit(channel, data);
```

Pi types channels as strings and payloads as `unknown`.
`shared/mikoto-types` supplies the channel/payload contract used by Mikoto
producers and receivers.

Mikoto event payloads are a deliberately trusted boundary. A supported
producer uses `MikotoEventEmitter` from the same exact `mikoto-types` commit as
the receiver. The receiver asserts the corresponding `MikotoEventPayload` and
does not repeat the contract as a Zod schema or handwritten runtime validator.
Third-party extensions may opt into the same convention.

This trust is intentionally unchecked. Raw `pi.events.emit()` calls, `any`,
different or stale `mikoto-types` commits, and channel collisions can all
bypass the contract. In those cases, behavior is undefined.

## Delivery model

Treat the event bus as best-effort, in-memory notification:

- `emit()` returns `void` and does not wait for asynchronous receivers.
- Messages are not queued, replayed, persisted, or sent to another process.
- A message is lost when no receiver is registered at the time it is emitted.
- The sender cannot assume that the receiving extension is installed, enabled,
  or still active.
- More than one listener can subscribe to the same channel.
- Receiver failures do not provide a result to the sender.

Register receivers in the extension factory. Send messages later from tools,
commands, or lifecycle handlers—not during extension loading—so all configured
extension factories have had an opportunity to register their listeners.

## Defining a new receiver

The receiving extension owns the channel name, payload contract, defaults, and
business behavior.

### 1. Register the contract in `mikoto-types`

Add a readonly payload type and channel mapping to
`shared/mikoto-types/index.d.ts`:

```ts
export type MikotoWidgetRefreshEvent = {
  readonly widgetId: string;
  readonly force?: boolean;
};

export type MikotoEventMap = {
  // Existing channels remain here.
  readonly "mikoto-sound:sound": MikotoSoundEvent;
  readonly "mikoto-widget:refresh": MikotoWidgetRefreshEvent;
};
```

Use a channel owned by the receiver, normally
`mikoto-<extension>:<operation>`. One channel has one canonical payload type.
`MikotoEventName`, `MikotoEventPayload`, and `MikotoEventEmitter`
automatically derive the contract from `MikotoEventMap`.

The TypeScript shape is the complete accepted payload contract. For example,
`widgetId: string` permits every string, including an empty string. If the
receiver needs to handle a value specially, represent that in the type when
possible or treat it as ordinary business behavior rather than assuming an
unwritten validation rule.

`mikoto-types` remains declaration-only: do not add Zod, runtime schemas,
constants, JavaScript entry points, or Pi resources to it. Extensions that
import these declarations should list `mikoto-types` as a development
dependency and use `import type`.

### 2. Assert the payload at the listener

Keep the unchecked assertion local and visible where Pi's `unknown` payload
enters the receiver:

```ts
import type { MikotoEventPayload } from "mikoto-types";

const WIDGET_REFRESH_EVENT = "mikoto-widget:refresh";

pi.events.on(WIDGET_REFRESH_EVENT, (data) => {
  const event =
    data as MikotoEventPayload<typeof WIDGET_REFRESH_EVENT>;

  refreshWidget(event);
});
```

Do not add a Zod schema, a handwritten shape guard, or malformed-event
diagnostics for a Mikoto event payload. A type assertion performs no runtime
check; it is conditionally safe because supported producers use the matching
typed emitter contract.

This exception applies only to Mikoto event payloads. Continue parsing and
validating genuinely untrusted values such as config files, JSON, network
responses, persisted data, and other public inputs. Those boundaries may use
Zod or another appropriate validator.

## Sending a message

Producers **must use** the emitter type from `mikoto-types`:

```ts
import type { MikotoEventEmitter } from "mikoto-types";

export default function mikotoProducer(pi: ExtensionAPI): void {
  const events: MikotoEventEmitter = pi.events;

  events.emit("mikoto-widget:refresh", {
    widgetId: "sidebar",
    force: true,
  });
}
```

Do not call `pi.events.emit()` directly for a Mikoto channel. The narrowed
emitter checks the channel/payload pair and prevents producer-side drift during
normal TypeScript compilation.

Emission remains fire-and-forget. Do not require the receiver to be loaded and
do not add a runtime dependency on the receiving extension merely to send an
event.

## Callback functions

An event may include a callback when the `mikoto-types` payload explicitly
declares it:

```ts
export type MikotoWidgetRefreshResult = {
  readonly refreshed: boolean;
};

export type MikotoWidgetRefreshEvent = {
  readonly widgetId: string;
  readonly callback?: (result: MikotoWidgetRefreshResult) => void;
};
```

The receiver trusts and invokes the asserted callback directly:

```ts
pi.events.on(WIDGET_REFRESH_EVENT, (data) => {
  const event =
    data as MikotoEventPayload<typeof WIDGET_REFRESH_EVENT>;

  const refreshed = refreshWidget(event);
  event.callback?.({ refreshed });
});
```

Callbacks have important limitations:

- They work only because Pi's event bus is in-process and passes references.
- They cannot be serialized through JSON, persisted in sessions, sent over
  RPC, or transferred to another process.
- The callback may be called zero times when no receiver is loaded.
- It may be called more than once when multiple listeners handle the channel.
- Callback implementations can throw or reject; define who catches and reports
  those failures.

Document callback cardinality and failure behavior in the channel contract.
Callbacks should normally be optional and senders must have a fallback. When a
request/response must be serializable or decoupled, prefer a response event
with a correlation ID instead of a function callback.

## Revision policy and testing

`mikoto-types` does **not** use SemVer. The `version` field in `package.json`
is not used as a compatibility signal: every commit is a different version.
All participating extensions must use the same exact `mikoto-types` commit;
otherwise, behavior is undefined. Update all in-repository extensions together
when the contract changes. Third-party extensions must use that same commit.

- Run normal TypeScript checks for every affected producer and receiver.
- Test valid event payloads and the receiver's business behavior.
- Do not test malformed Mikoto payload handling: it is outside the supported
  contract.
- Continue testing malformed and semantically invalid data at untrusted
  boundaries such as config parsing.
- If callbacks are supported, test absent receivers, repeated listeners,
  callback failures, and async behavior where applicable.
