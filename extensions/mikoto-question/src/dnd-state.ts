import type { DndState } from "./types.ts";

export const DND_STATE_ENTRY_TYPE = "mikoto-question:dnd-state";
export const DND_UI_ENTRY_TYPE = "mikoto-question:dnd-ui";
export const DND_AVAILABILITY_MESSAGE_TYPE =
	"mikoto-question:dnd-availability";

const LEGACY_DND_STATE_ENTRY_TYPE = "pi-user-input:dnd-state";
const LEGACY_DND_UI_ENTRY_TYPE = "pi-user-input:dnd-ui";

export const DND_UI_ENTRY_TYPES = [
	DND_UI_ENTRY_TYPE,
	LEGACY_DND_UI_ENTRY_TYPE,
] as const;

export const DND_UNAVAILABLE_ERROR =
	"request_user_input is unavailable because the user is temporarily unavailable. Make reasonable assumptions and continue whenever possible.";

export const DND_AVAILABILITY_MESSAGE =
	"User previously enabled Do not disturb mode to ignore all request_user_input calls. The user is available again.";

export function dndUiMessage(enabled: boolean): string {
	return `Do not disturb mode is ${enabled ? "on" : "off"}`;
}

export function initialDndState(): DndState {
	return {
		enabled: false,
		enabledSinceLastTurnEnd: false,
		availabilityNoticePending: false,
	};
}

export function toggleDnd(state: DndState): DndState {
	const enabled = !state.enabled;
	return {
		...state,
		enabled,
		enabledSinceLastTurnEnd: state.enabledSinceLastTurnEnd || enabled,
	};
}

export function endDndTurn(state: DndState): DndState {
	return {
		enabled: false,
		enabledSinceLastTurnEnd: false,
		availabilityNoticePending:
			state.availabilityNoticePending || state.enabledSinceLastTurnEnd,
	};
}

export function consumeAvailabilityNotice(
	state: DndState,
): { state: DndState; shouldNotify: boolean } {
	if (state.enabled || !state.availabilityNoticePending) {
		return { state, shouldNotify: false };
	}

	return {
		state: { ...state, availabilityNoticePending: false },
		shouldNotify: true,
	};
}

export function isDndState(value: unknown): value is DndState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<DndState>;
	return (
		typeof candidate.enabled === "boolean" &&
		typeof candidate.enabledSinceLastTurnEnd === "boolean" &&
		typeof candidate.availabilityNoticePending === "boolean"
	);
}

export function restoreDndState(
	entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
): DndState {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry?.type === "custom" &&
			(entry.customType === DND_STATE_ENTRY_TYPE ||
				entry.customType === LEGACY_DND_STATE_ENTRY_TYPE) &&
			isDndState(entry.data)
		) {
			return { ...entry.data };
		}
	}
	return initialDndState();
}
