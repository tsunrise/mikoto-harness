import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	DND_AVAILABILITY_MESSAGE,
	DND_UNAVAILABLE_ERROR,
	TUI_UNAVAILABLE_ERROR,
	default as mikotoQuestion,
} from "../src/index.ts";
import { DND_UI_ENTRY_TYPE } from "../src/dnd-state.ts";
import type { RequestUserInputParams } from "../src/schema.ts";
import type {
	QuestionnaireOutcome,
	RequestUserInputDetails,
} from "../src/types.ts";
import { makeKeybindings, plainTheme } from "./fixtures.ts";

interface CapturedTool {
	name: string;
	label: string;
	description: string;
	executionMode?: string;
	parameters: unknown;
	execute(
		id: string,
		params: RequestUserInputParams,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{
		content: Array<{ type: "text"; text: string }>;
		details: RequestUserInputDetails;
	}>;
}

interface CapturedCommand {
	handler(args: string, ctx: ExtensionContext): Promise<void>;
}

type CapturedHandler = (
	event: unknown,
	ctx: ExtensionContext,
) => Promise<unknown>;

function setupExtension(): {
	tool: CapturedTool;
	command: CapturedCommand;
	handlers: Map<string, CapturedHandler>;
	entries: Array<{ customType: string; data: unknown }>;
	entryRenderer: (
		entry: { data?: unknown },
		options: { expanded: boolean },
		theme: typeof plainTheme,
	) => { render(width: number): string[] } | undefined;
} {
	let tool: CapturedTool | undefined;
	let command: CapturedCommand | undefined;
	let entryRenderer:
		| ((
				entry: { data?: unknown },
				options: { expanded: boolean },
				theme: typeof plainTheme,
		  ) => { render(width: number): string[] } | undefined)
		| undefined;
	const handlers = new Map<string, CapturedHandler>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const api = {
		registerTool(value: unknown) {
			tool = value as CapturedTool;
		},
		registerCommand(_name: string, value: unknown) {
			command = value as CapturedCommand;
		},
		registerEntryRenderer(_customType: string, renderer: unknown) {
			entryRenderer = renderer as typeof entryRenderer;
		},
		on(name: string, handler: unknown) {
			handlers.set(name, handler as CapturedHandler);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;

	mikotoQuestion(api);
	assert.ok(tool);
	assert.ok(command);
	assert.ok(entryRenderer);
	return { tool, command, handlers, entries, entryRenderer };
}

function makeContext(
	mode: "tui" | "rpc" | "json" | "print" = "tui",
): { ctx: ExtensionContext } {
	const tui = {
		terminal: { rows: 24, columns: 100 },
		requestRender() {},
	} as unknown as TUI;

	const ui = {
		theme: plainTheme,
		async custom(
			factory: (
				tui: TUI,
				theme: typeof plainTheme,
				keybindings: KeybindingsManager,
				done: (outcome: QuestionnaireOutcome) => void,
			) => {
				focused?: boolean;
				handleInput?(data: string): void;
			},
		): Promise<QuestionnaireOutcome> {
			return new Promise((resolve) => {
				const component = factory(
					tui,
					plainTheme,
					makeKeybindings(),
					resolve,
				);
				component.focused = true;
				component.handleInput?.("\r");
			});
		},
	};

	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		ui,
		abort() {},
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getCwd: () => "/tmp/project",
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({
			tokens: 0,
			contextWindow: 128_000,
			percent: 0,
		}),
		model: {
			id: "gpt-5.4",
			provider: "openai",
			reasoning: true,
			contextWindow: 128_000,
		},
		thinkingLevel: "high",
	} as unknown as ExtensionContext;
	return { ctx };
}

const params: RequestUserInputParams = {
	questions: [
		{
			id: "confirm",
			header: "Confirm",
			question: "Proceed?",
			options: [
				{
					label: "Yes (Recommended)",
					description: "Continue.",
				},
				{
					label: "No",
					description: "Stop.",
				},
			],
		},
	],
};

describe("extension integration", () => {
	it("registers the always-available sequential Codex-compatible tool", () => {
		const { tool } = setupExtension();
		assert.equal(tool.name, "request_user_input");
		assert.equal(tool.label, "Mikoto Question");
		assert.equal(tool.executionMode, "sequential");
		assert.equal(
			tool.description,
			"Request user input for one to three short questions and wait for the response.",
		);
		assert.doesNotMatch(tool.description, /Plan mode/);
	});

	it("returns compact Codex response JSON after TUI selection", async () => {
		const { tool } = setupExtension();
		const { ctx } = makeContext();
		const result = await tool.execute(
			"call-1",
			params,
			new AbortController().signal,
			undefined,
			ctx,
		);
		assert.equal(
			result.content[0]?.text,
			'{"answers":{"confirm":{"answers":["Yes (Recommended)"]}}}',
		);
		assert.deepEqual(result.details.response, {
			answers: {
				confirm: { answers: ["Yes (Recommended)"] },
			},
		});
	});

	it("rejects in non-TUI modes without opening a prompt", async () => {
		const { tool } = setupExtension();
		const { ctx } = makeContext("print");
		await assert.rejects(
			tool.execute("call-1", params, undefined, undefined, ctx),
			new RegExp(TUI_UNAVAILABLE_ERROR),
		);
	});

	it("shows UI-only DND messages, rejects calls, resets, and injects one LLM notice", async () => {
		const { tool, command, handlers, entries, entryRenderer } = setupExtension();
		const { ctx } = makeContext();
		await command.handler("", ctx);
		const onEntry = entries.find(
			(entry) =>
				entry.customType === DND_UI_ENTRY_TYPE &&
				(entry.data as { enabled?: boolean }).enabled === true,
		);
		assert.ok(onEntry);
		assert.equal(
			entryRenderer(
				{ data: onEntry.data },
				{ expanded: false },
				plainTheme,
			)?.render(80)[0]?.trim(),
			"Do not disturb mode is on",
		);

		await assert.rejects(
			tool.execute("call-1", params, undefined, undefined, ctx),
			new RegExp(DND_UNAVAILABLE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);

		await handlers.get("turn_end")?.({}, ctx);
		const offEntry = entries.find(
			(entry) =>
				entry.customType === DND_UI_ENTRY_TYPE &&
				(entry.data as { enabled?: boolean }).enabled === false,
		);
		assert.ok(offEntry);
		assert.equal(
			entryRenderer(
				{ data: offEntry.data },
				{ expanded: false },
				plainTheme,
			)?.render(80)[0]?.trim(),
			"Do not disturb mode is off",
		);

		const first = (await handlers.get("before_agent_start")?.(
			{},
			ctx,
		)) as
			| { message?: { content?: string; display?: boolean; customType?: string } }
			| undefined;
		assert.equal(first?.message?.content, DND_AVAILABILITY_MESSAGE);
		assert.equal(first?.message?.display, false);
		assert.match(first?.message?.customType ?? "", /dnd-availability/);
		const second = await handlers.get("before_agent_start")?.({}, ctx);
		assert.equal(second, undefined);
		assert.ok(entries.length >= 3);
	});

	it("keeps DND on when re-enabled between turns and defers the availability message", async () => {
		const { tool, command, handlers } = setupExtension();
		const { ctx } = makeContext();

		await command.handler("", ctx);
		await handlers.get("turn_end")?.({}, ctx);
		await command.handler("", ctx);

		const deferred = await handlers.get("before_agent_start")?.({}, ctx);
		assert.equal(deferred, undefined);
		await assert.rejects(
			tool.execute("call-1", params, undefined, undefined, ctx),
			new RegExp(
				DND_UNAVAILABLE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			),
		);

		await handlers.get("turn_end")?.({}, ctx);
		const nextTurn = (await handlers.get("before_agent_start")?.(
			{},
			ctx,
		)) as { message?: { content?: string } } | undefined;
		assert.equal(nextTurn?.message?.content, DND_AVAILABILITY_MESSAGE);
	});
});
