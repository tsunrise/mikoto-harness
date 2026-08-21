/**
 * Payload accepted by the `mikoto-sound:sound` inter-extension event.
 *
 * An omitted effect selects `require-attention`.
 */
export type MikotoSoundEvent = {
	readonly effect?: string;
};

/** Compile-time source of truth for Mikoto inter-extension event channels. */
export type MikotoEventMap = {
	readonly "mikoto-sound:sound": MikotoSoundEvent;
};

export type MikotoEventName = keyof MikotoEventMap;

export type MikotoEventPayload<Name extends MikotoEventName> =
	MikotoEventMap[Name];

/**
 * Producer-only typed view of Pi's event bus.
 *
 * A receiver may trust an event only when its producer uses MikotoEventEmitter
 * from the same exact mikoto-types commit. Raw emitters and different commits
 * produce undefined behavior. package.json versions are not compatibility
 * signals.
 */
export type MikotoEventEmitter = {
	emit<Name extends MikotoEventName>(
		channel: Name,
		data: MikotoEventPayload<Name>,
	): void;
};
