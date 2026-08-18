import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DND_STATE_ENTRY_TYPE,
	consumeAvailabilityNotice,
	dndUiMessage,
	endDndTurn,
	initialDndState,
	restoreDndState,
	toggleDnd,
} from "../src/dnd-state.ts";

describe("DND state", () => {
	it("formats the UI-only on/off messages", () => {
		assert.equal(dndUiMessage(true), "Do not disturb mode is on");
		assert.equal(dndUiMessage(false), "Do not disturb mode is off");
	});

	it("remembers that DND was enabled even after a manual toggle off", () => {
		let state = toggleDnd(initialDndState());
		assert.equal(state.enabled, true);
		assert.equal(state.enabledSinceLastTurnEnd, true);
		state = toggleDnd(state);
		assert.equal(state.enabled, false);
		assert.equal(state.enabledSinceLastTurnEnd, true);
	});

	it("disables at turn end and emits one availability notice", () => {
		let state = toggleDnd(initialDndState());
		state = endDndTurn(state);
		assert.deepEqual(state, {
			enabled: false,
			enabledSinceLastTurnEnd: false,
			availabilityNoticePending: true,
		});
		const first = consumeAvailabilityNotice(state);
		assert.equal(first.shouldNotify, true);
		const second = consumeAvailabilityNotice(first.state);
		assert.equal(second.shouldNotify, false);
	});

	it("defers a pending notice while DND is enabled again", () => {
		const pending = endDndTurn(toggleDnd(initialDndState()));
		const enabledAgain = toggleDnd(pending);
		const result = consumeAvailabilityNotice(enabledAgain);
		assert.equal(result.shouldNotify, false);
		assert.equal(result.state.availabilityNoticePending, true);
	});

	it("uses current DND status when it was toggled on and off between turns", () => {
		const pending = endDndTurn(toggleDnd(initialDndState()));
		const enabledBetweenTurns = toggleDnd(pending);
		const disabledBetweenTurns = toggleDnd(enabledBetweenTurns);
		assert.equal(disabledBetweenTurns.enabled, false);
		assert.equal(disabledBetweenTurns.enabledSinceLastTurnEnd, true);

		const beforeNextTurn = consumeAvailabilityNotice(disabledBetweenTurns);
		assert.equal(beforeNextTurn.shouldNotify, true);
		assert.equal(beforeNextTurn.state.availabilityNoticePending, false);
	});

	it("restores the latest state entry on the active branch", () => {
		const older = toggleDnd(initialDndState());
		const newer = endDndTurn(older);
		assert.deepEqual(
			restoreDndState([
				{ type: "message" },
				{ type: "custom", customType: DND_STATE_ENTRY_TYPE, data: older },
				{ type: "custom", customType: "other", data: {} },
				{ type: "custom", customType: DND_STATE_ENTRY_TYPE, data: newer },
			]),
			newer,
		);
	});

	it("restores state written by pi-user-input before the rename", () => {
		const state = toggleDnd(initialDndState());
		assert.deepEqual(
			restoreDndState([
				{
					type: "custom",
					customType: "pi-user-input:dnd-state",
					data: state,
				},
			]),
			state,
		);
	});
});
