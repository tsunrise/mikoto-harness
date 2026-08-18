# Inter-extension communication

Mikoto extensions communicate through Pi's shared in-process event bus:

```ts
pi.events.on(channel, receiver);
pi.events.emit(channel, data);
```

The bus is intentionally loose at runtime: channels are strings and payloads
are `unknown`. `shared/mikoto-types` provides the compile-time contract used by
Mikoto producers, while each receiving extension owns runtime validation.

## Delivery model

Treat the event bus as best-effort, in-memory notification:

- `emit()` returns `void` and does not wait for asynchronous receivers.
- Messages are not queued, replayed, persisted, or sent to another process.
- A message is lost when no receiver is registered at the time it is emitted.
- The sender cannot assume that the receiving extension is installed, enabled,
  compatible, or still active.
- More than one listener can subscribe to the same channel.
- Receiver failures do not provide a result to the sender.

Register receivers in the extension factory. Send messages later from tools,
commands, or lifecycle handlers—not during extension loading—so all configured
extension factories have had an opportunity to register their listeners.

## Defining a new receiver

The receiving extension owns the channel name, payload contract, runtime
schema, and invalid-input behavior.

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
`mikoto-<extension>:<operation>`. One channel must have one canonical payload
type. `MikotoEventName`, `MikotoEventPayload`, and `MikotoEventEmitter`
automatically derive the new contract from `MikotoEventMap`.

Add compile-time tests under `shared/mikoto-types/test/` covering accepted and
rejected payloads. `mikoto-types` must remain declaration-only: do not add Zod,
runtime schemas, constants, JavaScript entry points, or Pi resources to it.

Extensions that import these declarations should list `mikoto-types` as a
development dependency and use `import type`.

### 2. Define a runtime schema in the receiver

Every receiver **must treat event data as untrusted**, even when all current
producers are in this repository. Pi's public bus accepts arbitrary channel
strings and `unknown` payloads, and another extension or version can bypass
`mikoto-types`.

Prefer a receiver-local Zod schema:

```ts
import { z } from "zod";
import type { MikotoEventPayload } from "mikoto-types";

const widgetRefreshSchema = z.strictObject({
  widgetId: z.string().min(1),
  force: z.boolean().optional(),
});

type ParsedWidgetRefresh = z.infer<typeof widgetRefreshSchema>;

type Assert<Condition extends true> = Condition;
type SchemaOutputMatchesContract = Assert<
  z.output<typeof widgetRefreshSchema> extends
    MikotoEventPayload<"mikoto-widget:refresh">
    ? true
    : false
>;
type ContractMatchesSchemaInput = Assert<
  MikotoEventPayload<"mikoto-widget:refresh"> extends
    z.input<typeof widgetRefreshSchema>
    ? true
    : false
>;
```

The shared type and runtime schema are intentionally duplicated because they
serve different consumers. Add compile-time compatibility assertions so they
cannot silently drift. Use `z.infer` for extension-internal parsed types rather
than writing another TypeScript shape.

Zod is a runtime dependency of the receiving extension, not of
`mikoto-types`. Put it in that extension's `dependencies`.

If Zod cannot represent or validate the boundary, use another runtime
validator or a carefully tested handwritten validator. At minimum, validate:

- that the root value has the expected kind;
- required and optional fields;
- field value types and semantic constraints;
- the channel's explicit unknown-field policy; and
- callable fields before invoking them.

Never replace runtime validation with a type assertion such as
`data as MikotoEventPayload<...>`.

### 3. Validate before any use

Treat the listener's native `unknown` input as opaque. Pass it directly to the
runtime validator and fail closed:

```ts
pi.events.on("mikoto-widget:refresh", (data) => {
  const parsed = widgetRefreshSchema.safeParse(data);
  if (!parsed.success) {
    reportInvalidEvent(z.prettifyError(parsed.error));
    return;
  }

  refreshWidget(parsed.data);
});
```

Decide and test whether unknown fields are rejected, stripped, or preserved; do
not leave this to accident.

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
emitter checks the channel/payload pair and prevents producer-side drift.

Emission remains fire-and-forget. Do not require the receiver to be loaded and
do not add a runtime dependency on the receiving extension merely to send an
event.

## Callback functions

An event may include a callback only when both the `mikoto-types` payload and
the receiver's runtime schema explicitly allow it.

Shared declaration:

```ts
export type MikotoWidgetRefreshResult = {
  readonly refreshed: boolean;
};

export type MikotoWidgetRefreshEvent = {
  readonly widgetId: string;
  readonly callback?: (result: MikotoWidgetRefreshResult) => void;
};
```

Receiver-local Zod schema:

```ts
const widgetRefreshResultSchema = z.strictObject({
  refreshed: z.boolean(),
});

const widgetRefreshCallbackSchema = z.function({
  input: [widgetRefreshResultSchema],
  output: z.void(),
});

const widgetRefreshSchema = z.strictObject({
  widgetId: z.string().min(1),
  callback: widgetRefreshCallbackSchema.optional(),
});
```

`z.function()` verifies that the value is callable. Parsing returns a wrapper
that validates arguments and the return value whenever the receiver invokes
the parsed callback. Invoke `parsed.data.callback`, not the original unparsed
function. For an asynchronous callback, declare a promise output in both the
shared type and Zod schema.

If only callability needs checking and preserving the original function
identity matters, a receiver can use:

```ts
type Callback = (result: MikotoWidgetRefreshResult) => void;

const callbackSchema = z.custom<Callback>(
  (value) => typeof value === "function",
);
```

This weaker form does not validate callback arguments or return values.

Callbacks have important limitations:

- They work only because Pi's event bus is in-process and passes references.
- They cannot be serialized through JSON, persisted in sessions, sent over
  RPC, or transferred to another process.
- The callback may be called zero times when no receiver is loaded.
- It may be called more than once when multiple listeners handle the channel.
- Callback implementations and Zod wrappers can throw or reject; define who
  catches and reports those failures.
- Zod validates a function contract but does not sandbox executable code.

Document callback cardinality and failure behavior in the channel contract.
Callbacks should normally be optional and senders must have a fallback. When a
request/response must be serializable or decoupled, prefer a response event
with a correlation ID instead of a function callback.

## Compatibility and testing

Treat the receiver's runtime schema as the authority at execution time and
`mikoto-types` as the authority at compile time.

- Adding an optional field is normally backward-compatible.
- Adding a required field, renaming a channel/field, or changing a field type
  is breaking and must follow `mikoto-types` SemVer.
- Test valid, malformed, and semantically invalid payloads.
- Verify invalid payloads cause no side effects.
- Verify producers compile only with recognized channel/payload pairs.
- If callbacks are supported, test argument/output validation, absent
  receivers, repeated listeners, thrown errors, and async behavior.
