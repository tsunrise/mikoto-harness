import type {
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { QuestionnaireState } from "./questionnaire-state.ts";
import type {
	QuestionnaireAction,
	QuestionnaireOutcome,
	RequestUserInputQuestion,
} from "./types.ts";

const TIP_SEPARATOR = " | ";

export class RequestUserInputComponent implements Focusable {
	private readonly state: QuestionnaireState;
	private readonly editor: Editor;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private suppressEditorChange = false;
	private _focused = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (outcome: QuestionnaireOutcome) => void;

	constructor(
		questions: readonly RequestUserInputQuestion[],
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (outcome: QuestionnaireOutcome) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.state = new QuestionnaireState(questions);
		const editorTheme: EditorTheme = {
			borderColor: (text) => this.theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => this.theme.fg("accent", text),
				selectedText: (text) => this.theme.fg("accent", text),
				description: (text) => this.theme.fg("muted", text),
				scrollInfo: (text) => this.theme.fg("dim", text),
				noMatch: (text) => this.theme.fg("warning", text),
			},
		};
		this.editor = new Editor(tui, editorTheme, { paddingX: 0 });
		this.editor.onChange = (text) => {
			if (!this.suppressEditorChange) this.state.setNote(text);
			this.refresh();
		};
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value && this.state.isNotesFocused;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	get controller(): QuestionnaireState {
		return this.state;
	}

	private refresh(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.tui.requestRender();
	}

	private syncEditor(): void {
		const note = this.state.currentAnswer?.note ?? "";
		if (this.editor.getExpandedText() !== note) {
			this.suppressEditorChange = true;
			this.editor.setText(note);
			this.suppressEditorChange = false;
		}
		this.editor.focused = this._focused && this.state.isNotesFocused;
	}

	private apply(action: QuestionnaireAction): void {
		if (action.type === "complete") {
			this.done({ status: "answered", response: action.response });
			return;
		}
		if (action.type === "interrupt") {
			this.done({ status: "interrupted" });
			return;
		}
		this.syncEditor();
		this.refresh();
	}

	private matches(data: string, keybinding: Parameters<KeybindingsManager["matches"]>[1]): boolean {
		return this.keybindings.matches(data, keybinding);
	}

	handleInput(data: string): void {
		if (this.state.isConfirmationFocused) {
			this.handleConfirmationInput(data);
			return;
		}

		if (
			matchesKey(data, Key.ctrl("p")) ||
			this.matches(data, "tui.select.pageUp")
		) {
			this.apply(this.state.moveQuestion(-1));
			return;
		}
		if (
			matchesKey(data, Key.ctrl("n")) ||
			this.matches(data, "tui.select.pageDown")
		) {
			this.apply(this.state.moveQuestion(1));
			return;
		}

		if (this.state.isNotesFocused) {
			this.handleNotesInput(data);
			return;
		}

		this.handleOptionsInput(data);
	}

	private handleConfirmationInput(data: string): void {
		if (
			this.matches(data, "tui.select.up") ||
			matchesKey(data, Key.up) ||
			data === "k"
		) {
			this.apply(this.state.moveConfirmation(-1));
			return;
		}
		if (
			this.matches(data, "tui.select.down") ||
			matchesKey(data, Key.down) ||
			data === "j"
		) {
			this.apply(this.state.moveConfirmation(1));
			return;
		}
		if (data === "1" || data === "2") {
			this.state.confirmationIndex = Number(data) - 1;
			this.refresh();
			return;
		}
		if (
			this.matches(data, "tui.select.confirm") ||
			matchesKey(data, Key.enter)
		) {
			this.apply(this.state.acceptConfirmation());
			return;
		}
		if (
			this.matches(data, "tui.select.cancel") ||
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.backspace)
		) {
			this.apply(this.state.cancelConfirmation());
		}
	}

	private handleNotesInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			this.matches(data, "tui.input.tab")
		) {
			this.apply(this.state.closeAndClearNotes());
			return;
		}
		if (this.matches(data, "app.interrupt")) {
			this.apply(this.state.interrupt());
			return;
		}
		if (
			matchesKey(data, Key.backspace) &&
			this.editor.getExpandedText().length === 0
		) {
			this.apply(this.state.closeAndClearNotes());
			return;
		}
		if (
			this.matches(data, "tui.select.up") ||
			this.matches(data, "tui.select.down")
		) {
			const delta = this.matches(data, "tui.select.up") ? -1 : 1;
			this.apply(this.state.moveOption(delta));
			return;
		}
		if (this.matches(data, "tui.input.submit")) {
			this.apply(this.state.submitNotes(this.editor.getExpandedText()));
			return;
		}

		this.editor.handleInput(data);
		this.state.setNote(this.editor.getExpandedText());
		this.refresh();
	}

	private handleOptionsInput(data: string): void {
		if (this.matches(data, "app.interrupt")) {
			this.apply(this.state.interrupt());
			return;
		}
		if (
			this.matches(data, "tui.select.up") ||
			matchesKey(data, Key.up) ||
			data === "k"
		) {
			this.apply(this.state.moveOption(-1));
			return;
		}
		if (
			this.matches(data, "tui.select.down") ||
			matchesKey(data, Key.down) ||
			data === "j"
		) {
			this.apply(this.state.moveOption(1));
			return;
		}
		if (
			(matchesKey(data, Key.left) || data === "h") &&
			this.state.questionCount > 1
		) {
			this.apply(this.state.moveQuestion(-1));
			return;
		}
		if (
			(matchesKey(data, Key.right) || data === "l") &&
			this.state.questionCount > 1
		) {
			this.apply(this.state.moveQuestion(1));
			return;
		}
		if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
			this.apply(this.state.clearSelection());
			return;
		}
		if (this.matches(data, "tui.input.tab")) {
			this.apply(this.state.openNotes());
			return;
		}
		if (matchesKey(data, Key.space)) {
			this.apply(this.state.commitHighlighted());
			return;
		}
		if (/^[1-9]$/.test(data)) {
			this.apply(this.state.acceptNumber(Number(data)));
			return;
		}
		if (
			this.matches(data, "tui.select.confirm") ||
			matchesKey(data, Key.enter)
		) {
			this.apply(this.state.acceptHighlighted());
			return;
		}

		if (isTextInput(data)) {
			this.apply(this.state.openNotes());
			if (this.state.isNotesFocused) {
				this.editor.handleInput(data);
				this.state.setNote(this.editor.getExpandedText());
				this.refresh();
			}
		}
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		if (this.cachedLines && this.cachedWidth === renderWidth) {
			return this.cachedLines;
		}

		const lines = this.state.isConfirmationFocused
			? this.renderConfirmation(renderWidth)
			: this.renderQuestion(renderWidth);
		this.cachedWidth = renderWidth;
		this.cachedLines = lines.map((line) =>
			truncateToWidth(line, renderWidth, ""),
		);
		return this.cachedLines;
	}

	private renderQuestion(width: number): string[] {
		const lines: string[] = [""];
		const question = this.state.currentQuestion;
		const answer = this.state.currentAnswer;
		if (!question || !answer) {
			lines.push(this.theme.fg("dim", "No questions"));
			return lines;
		}

		const progress = `Question ${this.state.currentIndex + 1}/${this.state.questionCount}${
			this.state.unansweredCount > 0
				? ` (${this.state.unansweredCount} unanswered)`
				: ""
		}`;
		addWrapped(lines, this.theme.fg("dim", progress), width, "  ");
		addWrapped(
			lines,
			this.theme.fg(answer.committed ? "text" : "accent", question.question),
			width,
			"  ",
		);
		lines.push("");

		const options = this.state.options;
		const maxVisible = Math.max(
			1,
			Math.min(options.length, this.tui.terminal.rows - (answer.notesVisible ? 16 : 10)),
		);
		const selected = answer.highlightedIndex ?? 0;
		const start = Math.max(
			0,
			Math.min(selected - maxVisible + 1, options.length - maxVisible),
		);
		const visibleOptions = options.slice(start, start + maxVisible);
		const maxLabelWidth = Math.min(
			Math.max(
				...visibleOptions.map((option, index) =>
					visibleWidth(`${start + index + 1}. ${option.label}`),
				),
			),
			Math.max(12, Math.floor(width * 0.55)),
		);

		for (let localIndex = 0; localIndex < visibleOptions.length; localIndex++) {
			const index = start + localIndex;
			const option = visibleOptions[localIndex];
			if (!option) continue;
			const highlighted = answer.highlightedIndex === index;
			const marker = highlighted ? "› " : "  ";
			const plainLabel = `${index + 1}. ${option.label}`;
			const label = highlighted
				? this.theme.fg("accent", plainLabel)
				: this.theme.fg("text", plainLabel);
			const padding = " ".repeat(
				Math.max(2, maxLabelWidth - visibleWidth(plainLabel) + 2),
			);
			addWrappedWithPrefix(
				lines,
				this.theme.fg(highlighted ? "accent" : "text", marker),
				`${label}${padding}${this.theme.fg("muted", option.description)}`,
				width,
			);
		}

		if (answer.notesVisible) {
			lines.push("");
			const placeholder =
				answer.highlightedIndex === null
					? "Select an option to add notes"
					: answer.note.length === 0
						? "Add notes"
						: "Notes";
			addWrapped(
				lines,
				this.theme.fg("muted", `› ${placeholder}`),
				width,
				"  ",
			);
			for (const line of this.editor.render(Math.max(1, width - 2))) {
				lines.push(`  ${line}`);
			}
		}

		lines.push("");
		const hidden = options.length > visibleOptions.length;
		const tips: string[] = [];
		if (hidden) tips.push(`option ${selected + 1}/${options.length}`);
		if (this.state.isNotesFocused) {
			tips.push("tab or esc to clear notes");
		} else if (answer.highlightedIndex !== null) {
			tips.push("tab to add notes");
		}
		const submitKey = this.bindingLabel(
			this.state.isNotesFocused ? "tui.input.submit" : "tui.select.confirm",
			"enter",
		);
		tips.push(
			this.state.questionCount === 1
				? `${submitKey} to submit answer`
				: this.state.isLastQuestion
					? `${submitKey} to submit all`
					: `${submitKey} to submit answer`,
		);
		if (this.state.questionCount > 1) {
			tips.push(
				this.state.isNotesFocused
					? "ctrl + p / ctrl + n change question"
					: "←/→ to navigate questions",
			);
		}
		if (!this.state.isNotesFocused || this.bindingLabel("app.interrupt", "esc") !== "esc") {
			tips.push(`${this.bindingLabel("app.interrupt", "esc")} to interrupt`);
		}
		lines.push(...renderTips(tips, width, this.theme));
		return lines;
	}

	private renderConfirmation(width: number): string[] {
		const lines = [""];
		addWrapped(
			lines,
			this.theme.bold("Submit with unanswered questions?"),
			width,
			"  ",
		);
		addWrapped(
			lines,
			this.theme.fg(
				"dim",
				`${this.state.unansweredCount} unanswered question${
					this.state.unansweredCount === 1 ? "" : "s"
				}`,
			),
			width,
			"  ",
		);
		lines.push("");

		const choices = [
			{
				label: "Proceed",
				description: `Submit with ${this.state.unansweredCount} unanswered question${
					this.state.unansweredCount === 1 ? "" : "s"
				}.`,
			},
			{
				label: "Go back",
				description: "Return to the first unanswered question.",
			},
		];
		for (let index = 0; index < choices.length; index++) {
			const choice = choices[index];
			if (!choice) continue;
			const selected = this.state.confirmationIndex === index;
			const prefix = selected ? "› " : "  ";
			addWrappedWithPrefix(
				lines,
				this.theme.fg(selected ? "accent" : "text", prefix),
				`${index + 1}. ${choice.label}  ${this.theme.fg("muted", choice.description)}`,
				width,
			);
		}
		lines.push("");
		addWrapped(
			lines,
			this.theme.fg("dim", "Press enter to confirm or esc to go back"),
			width,
			"  ",
		);
		return lines;
	}

	private bindingLabel(
		keybinding: Parameters<KeybindingsManager["getKeys"]>[0],
		fallback: string,
	): string {
		const key = this.keybindings.getKeys(keybinding)[0];
		return key ? String(key).replaceAll("+", " + ") : fallback;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.editor.invalidate();
	}
}

function isTextInput(data: string): boolean {
	if (data.startsWith("\x1b[200~")) return true;
	if (data.length !== 1) return false;
	return data.charCodeAt(0) >= 32 && data !== "\x7f";
}

function addWrapped(
	lines: string[],
	text: string,
	width: number,
	prefix = "",
): void {
	addWrappedWithPrefix(lines, prefix, text, width);
}

function addWrappedWithPrefix(
	lines: string[],
	prefix: string,
	text: string,
	width: number,
): void {
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth >= width) {
		lines.push(truncateToWidth(prefix, width, ""));
		return;
	}
	const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
	const continuation = " ".repeat(prefixWidth);
	for (let index = 0; index < wrapped.length; index++) {
		lines.push(`${index === 0 ? prefix : continuation}${wrapped[index]}`);
	}
}

function renderTips(tips: string[], width: number, theme: Theme): string[] {
	const available = Math.max(1, width - 2);
	const rows: string[] = [];
	let current = "";
	for (const tip of tips) {
		if (!current) {
			current = tip;
			continue;
		}
		const candidate = `${current}${TIP_SEPARATOR}${tip}`;
		if (visibleWidth(candidate) <= available) {
			current = candidate;
		} else {
			rows.push(current);
			current = tip;
		}
	}
	if (current || rows.length === 0) rows.push(current);
	return rows.map(
		(row) => `  ${truncateToWidth(theme.fg("dim", row), available, "…")}`,
	);
}
