import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MikotoEventEmitter } from "mikoto-types";
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
	QuestionnaireOutcome,
	RequestUserInputDetails,
	RequestUserInputQuestion,
} from "./types.ts";

const REQUEST_CANCELLED_ERROR =
	"request_user_input was cancelled before receiving a response";
const TUI_UNAVAILABLE_ERROR =
	"request_user_input requires Pi's interactive TUI and is unavailable in this mode";

export default function mikotoQuestion(pi: ExtensionAPI): void {
	const events: MikotoEventEmitter = pi.events;

	pi.registerTool<typeof requestUserInputSchema, RequestUserInputDetails>({
		name: "request_user_input",
		label: "Question",
		description:
			"Request user input for one to three short questions and wait for the response.",
		parameters: requestUserInputSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
				events.emit("mikoto-sound:sound", {
					effect: "require-attention",
				});
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

    renderCall(args, theme, context) {
      return renderRequestCall(args, theme, context);
		},

		renderResult(result, options, theme) {
			return renderRequestResult(result, options, theme);
		},
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

export {
	REQUEST_CANCELLED_ERROR,
	TUI_UNAVAILABLE_ERROR,
};
