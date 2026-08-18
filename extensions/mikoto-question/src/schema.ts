import { Type, type Static } from "typebox";

export const requestUserInputOptionSchema = Type.Object(
	{
		description: Type.String({
			description: "One short sentence explaining impact/tradeoff if selected.",
		}),
		label: Type.String({
			description: "User-facing label (1-5 words).",
		}),
	},
	{
		additionalProperties: false,
		required: ["label", "description"],
	},
);

export const requestUserInputQuestionSchema = Type.Object(
	{
		header: Type.String({
			description: "Short header label shown in the UI (12 or fewer chars).",
		}),
		id: Type.String({
			description: "Stable identifier for mapping answers (snake_case).",
		}),
		options: Type.Array(requestUserInputOptionSchema, {
			description:
				'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.',
		}),
		question: Type.String({
			description: "Single-sentence prompt shown to the user.",
		}),
	},
	{
		additionalProperties: false,
		required: ["id", "header", "question", "options"],
	},
);

export const requestUserInputSchema = Type.Object(
	{
		questions: Type.Array(requestUserInputQuestionSchema, {
			description: "Questions to show the user. Prefer 1 and do not exceed 3",
		}),
	},
	{ additionalProperties: false },
);

export type RequestUserInputParams = Static<typeof requestUserInputSchema>;

export function validateRequestUserInputParams(params: RequestUserInputParams): void {
	if (params.questions.some((question) => question.options.length === 0)) {
		throw new Error("request_user_input requires non-empty options for every question");
	}
}
