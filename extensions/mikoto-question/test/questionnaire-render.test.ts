import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { RequestUserInputComponent } from "../src/questionnaire-component.ts";
import { renderRequestCall } from "../src/result-renderer.ts";
import type { QuestionnaireOutcome } from "../src/types.ts";
import {
	makeKeybindings,
	plainTheme,
	questions,
} from "./fixtures.ts";

function makeTui(): TUI {
	return {
		terminal: { rows: 24, columns: 100 },
		requestRender() {},
	} as unknown as TUI;
}

describe("RequestUserInputComponent", () => {
	it("updates the tool call summary when the question count changes", () => {
		const call = renderRequestCall({ questions }, plainTheme as Theme);
		const single = renderRequestCall({ questions: questions.slice(0, 1) }, plainTheme as Theme);
		assert.notDeepEqual(call.render(80), single.render(80));
		assert.ok(call.render(80).every((line) => visibleWidth(line) <= 80));
	});

	it("renders caller options within width and updates selection and question navigation", () => {
		const component = new RequestUserInputComponent(
			questions,
			makeTui(),
			plainTheme,
			makeKeybindings(),
			() => {},
		);
		const lines = component.render(80);
		const output = lines.join("\n");
		for (const option of questions[0]!.options) assert.ok(output.includes(option.label));
		assert.equal(component.controller.options.length, questions[0]!.options.length + 1);
		component.handleInput("\x1b[B");
		assert.equal(component.controller.currentAnswer?.highlightedIndex, 1);
		assert.notDeepEqual(component.render(80), lines);
		component.handleInput("\x1b[B");
		assert.equal(component.controller.currentAnswer?.highlightedIndex, component.controller.otherOptionIndex);
		const beforeNavigation = component.render(80);
		component.handleInput("\x1b[C");
		assert.equal(component.controller.currentIndex, 1);
		assert.notDeepEqual(component.render(80), beforeNavigation);
		for (const option of questions[1]!.options) assert.ok(component.render(80).join("\n").includes(option.label));
		component.handleInput("\x1b[D");
		assert.equal(component.controller.currentIndex, 0);
		assert.equal(component.controller.currentAnswer?.highlightedIndex, component.controller.otherOptionIndex);
		for (const line of lines) assert.ok(visibleWidth(line) <= 80);
	});

	it("propagates focus to the notes editor and completes from keyboard input", () => {
		let outcome: QuestionnaireOutcome | undefined;
		const component = new RequestUserInputComponent(
			[questions[0]!],
			makeTui(),
			plainTheme as Theme,
			makeKeybindings(),
			(value) => {
				outcome = value;
			},
		);
		component.focused = true;
		component.handleInput("tab");
		for (const character of "A custom note") component.handleInput(character);
		const noteLines = component.render(80);
		assert.ok(noteLines.join("").includes(CURSOR_MARKER));
		component.handleInput("\r");
		assert.equal(outcome?.status, "answered");
		if (outcome?.status !== "answered") return;
		assert.deepEqual(outcome.response.answers.database, {
			answers: [
				"PostgreSQL (Recommended)",
				"user_note: A custom note",
			],
		});
	});

	it("shows unanswered confirmation and returns to the first question", () => {
		const component = new RequestUserInputComponent(
			questions,
			makeTui(),
			plainTheme,
			makeKeybindings(),
			() => {},
		);
		component.handleInput("\x1b[C");
		component.handleInput("\x7f");
		component.handleInput("\r");
		assert.equal(component.controller.isConfirmationFocused, true);
		const confirmation = component.render(80);
		assert.ok(confirmation.length > 0);
		assert.ok(confirmation.every((line) => visibleWidth(line) <= 80));
		component.handleInput("\x1b");
		assert.equal(component.controller.currentIndex, 0);
		assert.equal(component.controller.isConfirmationFocused, false);
		assert.notDeepEqual(component.render(80), confirmation);
	});
});
