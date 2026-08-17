import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	requestUserInputSchema,
	validateRequestUserInputParams,
} from "../src/schema.ts";

describe("request_user_input schema", () => {
	it("matches the Codex public JSON schema", () => {
		assert.deepEqual(requestUserInputSchema, {
			type: "object",
			required: ["questions"],
			properties: {
				questions: {
					type: "array",
					items: {
						type: "object",
						required: ["id", "header", "question", "options"],
						properties: {
							id: {
								type: "string",
								description:
									"Stable identifier for mapping answers (snake_case).",
							},
							header: {
								type: "string",
								description:
									"Short header label shown in the UI (12 or fewer chars).",
							},
							question: {
								type: "string",
								description: "Single-sentence prompt shown to the user.",
							},
							options: {
								type: "array",
								items: {
									type: "object",
									required: ["label", "description"],
									properties: {
										label: {
											type: "string",
											description: "User-facing label (1-5 words).",
										},
										description: {
											type: "string",
											description:
												"One short sentence explaining impact/tradeoff if selected.",
										},
									},
									additionalProperties: false,
								},
								description:
									'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.',
							},
						},
						additionalProperties: false,
					},
					description:
						"Questions to show the user. Prefer 1 and do not exceed 3",
				},
			},
			additionalProperties: false,
		});
		assert.equal("minItems" in requestUserInputSchema.properties.questions, false);
		assert.equal("maxItems" in requestUserInputSchema.properties.questions, false);
	});

	it("rejects empty option lists like the Codex normalizer", () => {
		assert.throws(
			() =>
				validateRequestUserInputParams({
					questions: [
						{
							id: "choice",
							header: "Choice",
							question: "Choose?",
							options: [],
						},
					],
				}),
			/request_user_input requires non-empty options for every question/,
		);
	});
});
