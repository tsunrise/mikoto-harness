import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	TUI_UNAVAILABLE_ERROR,
	default as mikotoQuestion,
} from "../src/index.ts";
import type { RequestUserInputParams } from "../src/schema.ts";
import type {
	QuestionnaireOutcome,
	RequestUserInputDetails,
} from "../src/types.ts";
import { makeKeybindings, plainTheme } from "./fixtures.ts";

interface CapturedTool {
  renderCall: NonNullable<ToolDefinition["renderCall"]>;
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

type EmittedEvent = { channel: string; data: unknown };

function setupExtension(onEmit?: (event: EmittedEvent) => void): {
	tool: CapturedTool;
	events: EmittedEvent[];
} {
	let tool: CapturedTool | undefined;
	const events: EmittedEvent[] = [];
	const api = {
		registerTool(value: unknown) {
			tool = value as CapturedTool;
		},
		events: {
			emit(channel: string, data: unknown) {
				const event = { channel, data };
				events.push(event);
				onEmit?.(event);
			},
			on() {
				return () => {};
			},
		},
	} as unknown as ExtensionAPI;

	mikotoQuestion(api);
	assert.ok(tool);
	return { tool, events };
}

function makeContext(
	mode: "tui" | "rpc" | "json" | "print" = "tui",
	onCustom?: () => void,
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
			onCustom?.();
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
  it("forwards streaming lifecycle and expansion state to the registered call renderer", () => {
    const { tool } = setupExtension();
    const context: Parameters<CapturedTool["renderCall"]>[2] = {
      args: params,
      toolCallId: "preview-call",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd: "/tmp/project",
      executionStarted: false,
      argsComplete: false,
      isPartial: true,
      expanded: false,
      showImages: false,
      isError: false,
    };
    const preview = tool.renderCall(params, plainTheme, context);
    assert.ok(preview.render(120).join("\n").includes(params.questions[0]!.question));
    for (const transition of [
      { argsComplete: true },
      { executionStarted: true },
      { isPartial: false, isError: true },
    ]) {
      for (const expanded of [false, true]) {
        const component = tool.renderCall(params, plainTheme, {
          ...context, ...transition, expanded, lastComponent: preview,
        });
        assert.equal(component.render(120).length, 1);
        assert.ok(!component.render(120).join("\n").includes(params.questions[0]!.question));
      }
    }
  });

	it("registers the always-available sequential Codex-compatible tool", () => {
		const { tool } = setupExtension();
		assert.equal(tool.name, "request_user_input");
		assert.equal(tool.executionMode, "sequential");
	});

	it("returns compact Codex response JSON after TUI selection", async () => {
		let eventsAtCustom = 0;
		const { tool, events } = setupExtension();
		const { ctx } = makeContext("tui", () => {
			eventsAtCustom = events.length;
		});
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
		assert.equal(eventsAtCustom, 1);
		assert.deepEqual(events, [
			{
				channel: "mikoto-sound:sound",
				data: { effect: "require-attention" },
			},
		]);
	});

	it("rejects in non-TUI modes without opening a prompt", async () => {
		const { tool, events } = setupExtension();
		const { ctx } = makeContext("print");
		await assert.rejects(
			tool.execute("call-1", params, undefined, undefined, ctx),
			new RegExp(TUI_UNAVAILABLE_ERROR),
		);
		assert.deepEqual(events, []);
	});

	it("emits no sound when no questionnaire UI is opened", async () => {
		const { tool, events } = setupExtension();
		const { ctx } = makeContext();

		await assert.rejects(
			tool.execute(
				"call-invalid",
				{
					questions: [
						{
							...params.questions[0]!,
							options: [],
						},
					],
				},
				undefined,
				undefined,
				ctx,
			),
			/non-empty options/,
		);

		await tool.execute(
			"call-empty",
			{ questions: [] },
			undefined,
			undefined,
			ctx,
		);

		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			tool.execute(
				"call-aborted",
				params,
				controller.signal,
				undefined,
				ctx,
			),
			/cancelled/,
		);
		assert.deepEqual(events, []);
	});

});
