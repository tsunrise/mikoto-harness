import type {
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { RequestUserInputQuestion } from "../src/types.ts";

export const questions: RequestUserInputQuestion[] = [
	{
		id: "database",
		header: "Database",
		question: "Which database should we use?",
		options: [
			{
				label: "PostgreSQL (Recommended)",
				description: "Use a mature relational database.",
			},
			{
				label: "SQLite",
				description: "Keep deployment simple.",
			},
		],
	},
	{
		id: "delivery",
		header: "Delivery",
		question: "How should this be delivered?",
		options: [
			{
				label: "One pull request (Recommended)",
				description: "Ship the change together.",
			},
			{
				label: "Several pull requests",
				description: "Split review into stages.",
			},
		],
	},
];

export const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

const defaultBindings: Record<string, string[]> = {
	"tui.select.up": ["up"],
	"tui.select.down": ["down"],
	"tui.select.pageUp": ["pageUp"],
	"tui.select.pageDown": ["pageDown"],
	"tui.select.confirm": ["enter"],
	"tui.select.cancel": ["escape", "ctrl+c"],
	"tui.input.submit": ["enter"],
	"tui.input.tab": ["tab"],
	"app.interrupt": ["escape"],
};

export function makeKeybindings(
	overrides: Record<string, string[]> = {},
): KeybindingsManager {
	const bindings = { ...defaultBindings, ...overrides };
	return {
		matches(data: string, keybinding: string) {
			return (bindings[keybinding] ?? []).some((key) =>
				matchesKey(data, key as KeyId),
			);
		},
		getKeys(keybinding: string) {
			return bindings[keybinding] ?? [];
		},
	} as unknown as KeybindingsManager;
}
