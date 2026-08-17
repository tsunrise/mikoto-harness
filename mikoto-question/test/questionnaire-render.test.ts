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
	it("uses the Mikoto display name for the tool call", () => {
		const call = renderRequestCall({ questions }, plainTheme as Theme);
		assert.match(call.render(80).join("\n"), /Mikoto Question 2 questions/);
	});

	it("renders Codex-like progress, automatic option, and hints within width", () => {
		const component = new RequestUserInputComponent(
			questions,
			makeTui(),
			plainTheme,
			makeKeybindings(),
			() => {},
		);
		const lines = component.render(80);
		const output = lines.join("\n");
		assert.match(output, /Question 1\/2 \(2 unanswered\)/);
		assert.match(output, /› 1\. PostgreSQL \(Recommended\)/);
		assert.match(output, /3\. None of the above/);
		assert.match(output, /←\/→ to navigate questions/);
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
		assert.match(
			component.render(80).join("\n"),
			/Submit with unanswered questions\?/,
		);
		component.handleInput("\x1b");
		assert.equal(component.controller.currentIndex, 0);
	});
});
