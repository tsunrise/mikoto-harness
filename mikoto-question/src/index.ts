import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	DND_AVAILABILITY_MESSAGE,
	DND_AVAILABILITY_MESSAGE_TYPE,
	DND_STATE_ENTRY_TYPE,
	DND_UI_ENTRY_TYPE,
	DND_UI_ENTRY_TYPES,
	DND_UNAVAILABLE_ERROR,
	consumeAvailabilityNotice,
	dndUiMessage,
	endDndTurn,
	initialDndState,
	restoreDndState,
	toggleDnd,
} from "./dnd-state.ts";
import { RequestUserInputComponent } from "./questionnaire-component.ts";
import {
	type RequestUserInputParams,
	requestUserInputSchema,
	validateRequestUserInputParams,
} from "./schema.ts";
import {
	renderRequestCall,
	renderRequestResult,
} from "./result-renderer.ts";
import type {
	DndState,
	QuestionnaireOutcome,
	RequestUserInputDetails,
	RequestUserInputQuestion,
} from "./types.ts";

const REQUEST_CANCELLED_ERROR =
	"request_user_input was cancelled before receiving a response";
const TUI_UNAVAILABLE_ERROR =
	"request_user_input requires Pi's interactive TUI and is unavailable in this mode";

export default function mikotoQuestion(pi: ExtensionAPI): void {
	let dndState = initialDndState();

	function persistDndState(): void {
		pi.appendEntry(DND_STATE_ENTRY_TYPE, { ...dndState });
	}

	function appendDndUiMessage(enabled: boolean): void {
		pi.appendEntry(DND_UI_ENTRY_TYPE, { enabled });
	}

	function replaceDndState(next: DndState): void {
		const changed = !sameDndState(dndState, next);
		const enabledChanged = dndState.enabled !== next.enabled;
		dndState = next;
		if (changed) persistDndState();
		if (enabledChanged) appendDndUiMessage(dndState.enabled);
	}

	for (const entryType of DND_UI_ENTRY_TYPES) {
		pi.registerEntryRenderer<{ enabled: boolean }>(
			entryType,
			(entry, _options, theme) => {
				if (typeof entry.data?.enabled !== "boolean") return undefined;
				return new Text(
					theme.fg("muted", dndUiMessage(entry.data.enabled)),
					1,
					0,
				);
			},
		);
	}

	pi.registerCommand("toggle-do-not-disturb", {
		description: "Toggle Do not disturb mode for request_user_input",
		handler: async () => {
			replaceDndState(toggleDnd(dndState));
		},
	});

	pi.registerTool<typeof requestUserInputSchema, RequestUserInputDetails>({
		name: "request_user_input",
		label: "Question",
		description:
			"Request user input for one to three short questions and wait for the response.",
		parameters: requestUserInputSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (dndState.enabled) {
				throw new Error(DND_UNAVAILABLE_ERROR);
			}
			validateRequestUserInputParams(params);
			if (ctx.mode !== "tui") {
				throw new Error(`${TUI_UNAVAILABLE_ERROR}: ${ctx.mode}`);
			}

			const questions = cloneQuestions(params);
			if (questions.length === 0) {
				const response = { answers: {} };
				return {
					content: [{ type: "text", text: JSON.stringify(response) }],
					details: { status: "answered", questions, response },
				};
			}
			if (signal?.aborted) throw new Error(REQUEST_CANCELLED_ERROR);

			let close:
				| ((outcome: QuestionnaireOutcome) => void)
				| undefined;
			const abort = () => close?.({ status: "interrupted" });
			signal?.addEventListener("abort", abort, { once: true });

			let outcome: QuestionnaireOutcome;
			try {
				outcome = await ctx.ui.custom<QuestionnaireOutcome>(
					(tui, theme, keybindings, done) => {
						close = done;
						return new RequestUserInputComponent(
							questions,
							tui,
							theme,
							keybindings,
							done,
						);
					},
				);
			} finally {
				signal?.removeEventListener("abort", abort);
				close = undefined;
			}

			if (outcome.status === "interrupted") {
				if (!signal?.aborted) ctx.abort();
				throw new Error(REQUEST_CANCELLED_ERROR);
			}

			return {
				content: [
					{ type: "text", text: JSON.stringify(outcome.response) },
				],
				details: {
					status: "answered",
					questions,
					response: outcome.response,
				},
			};
		},

		renderCall(args, theme) {
			return renderRequestCall(args, theme);
		},

		renderResult(result, options, theme) {
			return renderRequestResult(result, options, theme);
		},
	});

	pi.on("turn_end", async () => {
		replaceDndState(endDndTurn(dndState));
	});

	pi.on("before_agent_start", async () => {
		const consumed = consumeAvailabilityNotice(dndState);
		if (!consumed.shouldNotify) return;
		dndState = consumed.state;
		persistDndState();
		return {
			message: {
				customType: DND_AVAILABILITY_MESSAGE_TYPE,
				content: DND_AVAILABILITY_MESSAGE,
				display: false,
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		dndState = restoreDndState(ctx.sessionManager.getBranch());
	});

	pi.on("session_tree", async (_event, ctx) => {
		dndState = restoreDndState(ctx.sessionManager.getBranch());
	});
}

function cloneQuestions(params: RequestUserInputParams): RequestUserInputQuestion[] {
	return params.questions.map((question) => ({
		id: question.id,
		header: question.header,
		question: question.question,
		options: question.options.map((option) => ({
			label: option.label,
			description: option.description,
		})),
	}));
}

function sameDndState(left: DndState, right: DndState): boolean {
	return (
		left.enabled === right.enabled &&
		left.enabledSinceLastTurnEnd === right.enabledSinceLastTurnEnd &&
		left.availabilityNoticePending === right.availabilityNoticePending
	);
}

export {
	DND_AVAILABILITY_MESSAGE,
	DND_UNAVAILABLE_ERROR,
	REQUEST_CANCELLED_ERROR,
	TUI_UNAVAILABLE_ERROR,
};
