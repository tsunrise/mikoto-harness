import type {
	QuestionnaireAction,
	QuestionnaireAnswerState,
	QuestionnaireFocus,
	RequestUserInputOption,
	RequestUserInputQuestion,
	RequestUserInputResponse,
} from "./types.ts";

export const OTHER_OPTION: RequestUserInputOption = {
	label: "None of the above",
	description: "Optionally, add details in notes (tab).",
};

const RENDER: QuestionnaireAction = { type: "render" };

export class QuestionnaireState {
	readonly questions: RequestUserInputQuestion[];
	readonly answers: QuestionnaireAnswerState[];
	currentIndex = 0;
	focus: QuestionnaireFocus = "options";
	confirmationIndex = 0;

	constructor(questions: readonly RequestUserInputQuestion[]) {
		this.questions = questions.map((question) => ({
			...question,
			options: question.options.map((option) => ({ ...option })),
		}));
		this.answers = questions.map(() => ({
			highlightedIndex: 0,
			committed: false,
			note: "",
			notesVisible: false,
		}));
	}

	get questionCount(): number {
		return this.questions.length;
	}

	get currentQuestion(): RequestUserInputQuestion | undefined {
		return this.questions[this.currentIndex];
	}

	get currentAnswer(): QuestionnaireAnswerState | undefined {
		return this.answers[this.currentIndex];
	}

	get options(): RequestUserInputOption[] {
		const question = this.currentQuestion;
		return question ? [...question.options, OTHER_OPTION] : [];
	}

	get otherOptionIndex(): number {
		return this.currentQuestion?.options.length ?? 0;
	}

	get unansweredCount(): number {
		return this.answers.reduce(
			(count, answer) => count + (this.isAnswered(answer) ? 0 : 1),
			0,
		);
	}

	get answeredCount(): number {
		return this.questionCount - this.unansweredCount;
	}

	get isLastQuestion(): boolean {
		return this.currentIndex + 1 >= this.questionCount;
	}

	get isNotesFocused(): boolean {
		return this.focus === "notes";
	}

	get isConfirmationFocused(): boolean {
		return this.focus === "unanswered-confirmation";
	}

	private isAnswered(answer: QuestionnaireAnswerState): boolean {
		return answer.committed && answer.highlightedIndex !== null;
	}

	moveOption(delta: -1 | 1): QuestionnaireAction {
		const answer = this.currentAnswer;
		const optionCount = this.options.length;
		if (!answer || optionCount === 0) return RENDER;

		if (answer.highlightedIndex === null) {
			answer.highlightedIndex = delta > 0 ? 0 : optionCount - 1;
		} else {
			answer.highlightedIndex =
				(answer.highlightedIndex + delta + optionCount) % optionCount;
		}
		answer.committed = false;
		return RENDER;
	}

	moveQuestion(delta: -1 | 1): QuestionnaireAction {
		if (this.questionCount === 0) return RENDER;
		this.currentIndex =
			(this.currentIndex + delta + this.questionCount) % this.questionCount;
		this.focus = "options";
		return RENDER;
	}

	jumpToQuestion(index: number): QuestionnaireAction {
		if (index < 0 || index >= this.questionCount) return RENDER;
		this.currentIndex = index;
		this.focus = "options";
		return RENDER;
	}

	setHighlightedOption(index: number): QuestionnaireAction {
		const answer = this.currentAnswer;
		if (!answer || index < 0 || index >= this.options.length) return RENDER;
		answer.highlightedIndex = index;
		answer.committed = false;
		return RENDER;
	}

	commitHighlighted(): QuestionnaireAction {
		const answer = this.currentAnswer;
		if (answer?.highlightedIndex !== null && answer?.highlightedIndex !== undefined) {
			answer.committed = true;
		}
		return RENDER;
	}

	clearSelection(): QuestionnaireAction {
		const answer = this.currentAnswer;
		if (!answer) return RENDER;
		answer.highlightedIndex = null;
		answer.committed = false;
		answer.note = "";
		answer.notesVisible = false;
		return RENDER;
	}

	openNotes(): QuestionnaireAction {
		const answer = this.currentAnswer;
		if (!answer || answer.highlightedIndex === null) return RENDER;
		answer.notesVisible = true;
		this.focus = "notes";
		return RENDER;
	}

	closeAndClearNotes(): QuestionnaireAction {
		const answer = this.currentAnswer;
		if (!answer) return RENDER;
		answer.note = "";
		answer.notesVisible = false;
		answer.committed = false;
		this.focus = "options";
		return RENDER;
	}

	setNote(note: string): QuestionnaireAction {
		const answer = this.currentAnswer;
		if (!answer) return RENDER;
		answer.note = note;
		answer.notesVisible = true;
		answer.committed = false;
		return RENDER;
	}

	acceptHighlighted(): QuestionnaireAction {
		const answer = this.currentAnswer;
		if (!answer) return this.buildCompletion();

		if (answer.highlightedIndex === this.otherOptionIndex) {
			return this.openNotes();
		}

		if (answer.highlightedIndex !== null) {
			answer.committed = true;
		}
		return this.advanceOrSubmit();
	}

	acceptNumber(number: number): QuestionnaireAction {
		const index = number - 1;
		const answer = this.currentAnswer;
		if (!answer || index < 0 || index >= this.options.length) return RENDER;
		answer.highlightedIndex = index;
		answer.committed = true;
		return this.advanceOrSubmit();
	}

	submitNotes(note: string): QuestionnaireAction {
		const answer = this.currentAnswer;
		if (!answer) return this.buildCompletion();
		answer.note = note;
		answer.notesVisible = true;
		if (answer.highlightedIndex !== null) {
			answer.committed = true;
		}
		return this.advanceOrSubmit();
	}

	private advanceOrSubmit(): QuestionnaireAction {
		if (!this.isLastQuestion) {
			this.currentIndex++;
			this.focus = "options";
			return RENDER;
		}

		if (this.unansweredCount > 0) {
			this.confirmationIndex = 0;
			this.focus = "unanswered-confirmation";
			return RENDER;
		}
		return this.buildCompletion();
	}

	moveConfirmation(delta: -1 | 1): QuestionnaireAction {
		this.confirmationIndex = (this.confirmationIndex + delta + 2) % 2;
		return RENDER;
	}

	acceptConfirmation(): QuestionnaireAction {
		if (this.confirmationIndex === 0) {
			return this.buildCompletion();
		}
		return this.returnToFirstUnanswered();
	}

	cancelConfirmation(): QuestionnaireAction {
		return this.returnToFirstUnanswered();
	}

	private returnToFirstUnanswered(): QuestionnaireAction {
		const index = this.answers.findIndex((answer) => !this.isAnswered(answer));
		if (index >= 0) this.currentIndex = index;
		this.focus = "options";
		return RENDER;
	}

	interrupt(): QuestionnaireAction {
		return { type: "interrupt" };
	}

	buildResponse(): RequestUserInputResponse {
		const answers: RequestUserInputResponse["answers"] = {};
		for (let index = 0; index < this.questions.length; index++) {
			const question = this.questions[index];
			const answer = this.answers[index];
			if (!question || !answer || !this.isAnswered(answer)) {
				if (question) answers[question.id] = { answers: [] };
				continue;
			}

			const selected =
				answer.highlightedIndex === this.otherOptionIndex
					? OTHER_OPTION
					: question.options[answer.highlightedIndex ?? -1];
			const values = selected ? [selected.label] : [];
			const note = answer.note.trim();
			if (note) values.push(`user_note: ${note}`);
			answers[question.id] = { answers: values };
		}
		return { answers };
	}

	private buildCompletion(): QuestionnaireAction {
		return { type: "complete", response: this.buildResponse() };
	}
}
