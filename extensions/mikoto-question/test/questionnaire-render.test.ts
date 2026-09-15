import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { RequestUserInputComponent } from "../src/questionnaire-component.ts";
import type { QuestionnaireOutcome } from "../src/types.ts";
import {
  coloredTheme,
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
  it("renders answer shapes independently of the active question color", () => {
    const fourQuestions = Array.from({ length: 4 }, (_, index) => ({
      ...questions[index % questions.length]!,
      id: `question_${index}`,
    }));
    const component = new RequestUserInputComponent(
      fourQuestions, makeTui(), coloredTheme, makeKeybindings(), () => {},
    );
    const check = (glyphs: string[], active: number) => {
      const strip = component.render(80)[1]!;
      assert.equal(stripVTControlCharacters(strip), glyphs.join(" "));
      assert.equal(
        strip,
        glyphs.map((glyph, index) =>
          coloredTheme.fg(index === active ? "accent" : "text", glyph),
        ).join(" "),
      );
    };
    check(["□", "□", "□", "□"], 0);
    component.handleInput("\r");
    component.handleInput("\x1b[C");
    check(["■", "□", "□", "□"], 2);
    component.handleInput(" ");
    check(["■", "□", "■", "□"], 2);
    component.handleInput("\x1b[D");
    check(["■", "□", "■", "□"], 1);
    component.handleInput("\x1b[C");
    component.handleInput("\x7f");
    check(["■", "□", "□", "□"], 2);
    component.handleInput("\x1b[B");
    component.handleInput(" ");
    check(["■", "□", "■", "□"], 2);
    component.handleInput("\x1b[B");
    check(["■", "□", "□", "□"], 2);
    component.handleInput(" ");
    component.handleInput("tab");
    component.handleInput("x");
    check(["■", "□", "□", "□"], 2);
    component.invalidate();
    check(["■", "□", "□", "□"], 2);
  });

  it("wraps every square within narrow widths, including single questions and notes", () => {
    for (const count of [1, 4, 30]) {
      const items = Array.from({ length: count }, (_, index) => ({
        ...questions[0]!, id: `question_${index}`,
      }));
      const component = new RequestUserInputComponent(
        items, makeTui(), coloredTheme, makeKeybindings(), () => {},
      );
      component.controller.jumpToQuestion(count - 1);
      component.handleInput("tab");
      for (const width of [1, 2, 3, 8, 40, 80]) {
        const lines = component.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        const strip = lines.filter((line) => /[■□]/.test(line)).join("");
        assert.equal(stripVTControlCharacters(strip).replaceAll(" ", ""), "□".repeat(count));
        assert.ok(strip.includes(coloredTheme.fg("accent", "□")));
      }
    }
  });

  it("interrupts from the option list without submitting an answer", () => {
    const outcomes: QuestionnaireOutcome[] = [];
    const component = new RequestUserInputComponent(
      questions, makeTui(), plainTheme, makeKeybindings(), (outcome) => outcomes.push(outcome),
    );
    component.handleInput("\x1b");
    assert.deepEqual(outcomes, [{ status: "interrupted" }]);
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
