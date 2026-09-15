import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	OTHER_OPTION,
	QuestionnaireState,
} from "../src/questionnaire-state.ts";
import { questions } from "./fixtures.ts";

describe("QuestionnaireState", () => {
  it("reports answered status only for committed selections at valid indices", () => {
    const state = new QuestionnaireState(questions);
    const check = (expected: boolean[]) => {
      assert.deepEqual(questions.map((_, index) => state.isQuestionAnswered(index)), expected);
      assert.equal(state.answeredCount, expected.filter(Boolean).length);
    };
    check([false, false]);
    for (const index of [-1, 0.5, questions.length, NaN]) {
      assert.equal(state.isQuestionAnswered(index), false);
    }
    state.commitHighlighted();
    check([true, false]);
    state.moveQuestion(1);
    check([true, false]);
    state.commitHighlighted();
    check([true, true]);
    state.moveOption(1);
    check([true, false]);
    state.commitHighlighted();
    state.setNote("draft");
    check([true, false]);
    state.commitHighlighted();
    state.clearSelection();
    check([true, false]);
  });

	it("starts with a highlighted but unanswered first option", () => {
		const state = new QuestionnaireState(questions);
		assert.equal(state.currentAnswer?.highlightedIndex, 0);
		assert.equal(state.currentAnswer?.committed, false);
		assert.equal(state.unansweredCount, 2);
		assert.deepEqual(state.options.at(-1), OTHER_OPTION);
	});

	it("wraps option and question navigation", () => {
		const state = new QuestionnaireState(questions);
		state.moveOption(-1);
		assert.equal(state.currentAnswer?.highlightedIndex, state.options.length - 1);
		state.moveOption(1);
		assert.equal(state.currentAnswer?.highlightedIndex, 0);
		state.moveQuestion(-1);
		assert.equal(state.currentIndex, 1);
		state.moveQuestion(1);
		assert.equal(state.currentIndex, 0);
	});

	it("commits ordinary choices and serializes Codex-shaped answers", () => {
		const state = new QuestionnaireState(questions);
		assert.equal(state.acceptHighlighted().type, "render");
		assert.equal(state.currentIndex, 1);
		state.setHighlightedOption(1);
		const action = state.acceptHighlighted();
		assert.equal(action.type, "complete");
		if (action.type !== "complete") return;
		assert.deepEqual(action.response, {
			answers: {
				database: { answers: ["PostgreSQL (Recommended)"] },
				delivery: { answers: ["Several pull requests"] },
			},
		});
	});

	it("opens notes for the automatic option and appends a trimmed user_note", () => {
		const state = new QuestionnaireState([questions[0]!]);
		state.setHighlightedOption(state.otherOptionIndex);
		assert.equal(state.acceptHighlighted().type, "render");
		assert.equal(state.focus, "notes");
		const action = state.submitNotes("  Need an embedded database.  ");
		assert.equal(action.type, "complete");
		if (action.type !== "complete") return;
		assert.deepEqual(action.response.answers.database, {
			answers: [
				OTHER_OPTION.label,
				"user_note: Need an embedded database.",
			],
		});
	});

	it("keeps notes per question and clears them when leaving notes with Escape", () => {
		const state = new QuestionnaireState(questions);
		state.openNotes();
		state.setNote("first draft");
		state.moveQuestion(1);
		state.openNotes();
		state.setNote("second draft");
		state.moveQuestion(-1);
		assert.equal(state.currentAnswer?.note, "first draft");
		state.closeAndClearNotes();
		assert.equal(state.currentAnswer?.note, "");
		assert.equal(state.currentAnswer?.committed, false);
	});

	it("confirms submission when questions remain unanswered", () => {
		const state = new QuestionnaireState(questions);
		state.moveQuestion(1);
		state.clearSelection();
		state.acceptHighlighted();
		assert.equal(state.focus, "unanswered-confirmation");
		assert.equal(state.unansweredCount, 2);

		state.moveConfirmation(1);
		state.acceptConfirmation();
		assert.equal(state.focus, "options");
		assert.equal(state.currentIndex, 0);

		state.moveQuestion(1);
		state.setHighlightedOption(0);
		state.acceptHighlighted();
		assert.equal(state.focus, "unanswered-confirmation");
		const action = state.acceptConfirmation();
		assert.equal(action.type, "complete");
		if (action.type !== "complete") return;
		assert.deepEqual(action.response, {
			answers: {
				database: { answers: [] },
				delivery: { answers: ["One pull request (Recommended)"] },
			},
		});
	});

	it("supports digit selection of the automatic option without notes", () => {
		const state = new QuestionnaireState([questions[0]!]);
		const action = state.acceptNumber(state.options.length);
		assert.equal(action.type, "complete");
		if (action.type !== "complete") return;
		assert.deepEqual(action.response.answers.database, {
			answers: [OTHER_OPTION.label],
		});
	});
});
