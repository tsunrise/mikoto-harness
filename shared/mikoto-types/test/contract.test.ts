import type {
	MikotoEventEmitter,
	MikotoEventMap,
	MikotoEventName,
	MikotoEventPayload,
	MikotoSoundEvent,
} from "mikoto-types";

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2)
		? true
		: false;
type Assert<Value extends true> = Value;

type EventNameMatchesMap = Assert<
	Equal<MikotoEventName, keyof MikotoEventMap>
>;

const defaultEffect: MikotoEventPayload<"mikoto-sound:sound"> = {};
const namedEffect: MikotoSoundEvent = { effect: "completed" };

// @ts-expect-error The typed event contract requires an object payload.
const undefinedPayload: MikotoEventPayload<"mikoto-sound:sound"> = undefined;

// @ts-expect-error Sound effect names must be strings.
const invalidEffect: MikotoSoundEvent = { effect: 42 };

// @ts-expect-error Shared event payloads are immutable.
namedEffect.effect = "require-attention";

declare const piEvents: {
	emit(channel: string, data: unknown): void;
};

const events: MikotoEventEmitter = piEvents;
events.emit("mikoto-sound:sound", defaultEffect);
events.emit("mikoto-sound:sound", namedEffect);

// @ts-expect-error Unknown channels are not part of the central event map.
events.emit("mikoto-unknown:event", {});

// @ts-expect-error Channel payloads must match their mapped contract.
events.emit("mikoto-sound:sound", { effect: false });

void (undefined as unknown as EventNameMatchesMap);
void undefinedPayload;
void invalidEffect;
