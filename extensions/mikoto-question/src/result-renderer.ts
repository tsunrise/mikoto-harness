import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type {
	RequestUserInputAnswer,
	RequestUserInputDetails,
	RequestUserInputQuestion,
} from "./types.ts";

type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

export function renderRequestCall(
  args: unknown,
  theme: Theme,
  context: Pick<ToolRenderContext, "argsComplete" | "executionStarted" | "isPartial">,
): Text {
  const lines = [theme.fg("toolTitle", theme.bold("Question"))];
  // isPartial stays true while the user answers. We only preview arguments
  // while they stream; execution and final results also guard restored rows
  // and aborted streams that never received an argsComplete transition.
  if (
    context.argsComplete === false &&
    context.executionStarted === false &&
    context.isPartial === true &&
    isRecord(args) &&
    Array.isArray(args.questions)
  ) {
    for (const question of args.questions) {
      if (
        isRecord(question) &&
        typeof question.question === "string" &&
        question.question.trim().length > 0
      ) {
        lines.push(`  ${theme.fg("dim", "•")} ${theme.fg("text", question.question)}`);
      }
    }
  }
  return new Text(lines.join("\n"), 0, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function renderRequestResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: RequestUserInputDetails;
	},
	options: { isPartial: boolean },
	theme: Theme,
): Text {
	if (options.isPartial) {
		return new Text(theme.fg("warning", "Waiting for user input…"), 0, 0);
	}

	const details = result.details;
	if (!details || details.status !== "answered") {
		const text = result.content.find((item) => item.type === "text")?.text ?? "";
		return new Text(text, 0, 0);
	}

	return new Text(
		formatCompletedRequest(details.questions, details.response.answers, theme),
		0,
		0,
	);
}

export function formatCompletedRequest(
	questions: readonly RequestUserInputQuestion[],
	answers: Readonly<Record<string, RequestUserInputAnswer>>,
	theme: Theme,
): string {
	const answered = questions.filter(
		(question) => (answers[question.id]?.answers.length ?? 0) > 0,
	).length;
	const lines: string[] = [
		`${theme.fg("dim", "•")} ${theme.fg(
			"dim",
			`${answered}/${questions.length} answered`,
		)}`,
	];

	for (const question of questions) {
		const answer = answers[question.id];
		const values = answer?.answers ?? [];
		lines.push(
			`  ${theme.fg("dim", "•")} ${question.question}${
				values.length === 0 ? theme.fg("dim", " (unanswered)") : ""
			}`,
		);
		if (values.length === 0) continue;

		const { options, note } = splitAnswer(values);
		for (const option of options) {
			lines.push(
				`    ${theme.fg("dim", "answer: ")}${theme.fg("accent", option)}`,
			);
		}
		if (note !== undefined) {
			lines.push(
				`    ${theme.fg("dim", "note: ")}${theme.fg("accent", note)}`,
			);
		}
	}
	return lines.join("\n");
}

export function splitAnswer(values: readonly string[]): {
	options: string[];
	note: string | undefined;
} {
	const options: string[] = [];
	let note: string | undefined;
	for (const value of values) {
		if (value.startsWith("user_note: ")) {
			note = value.slice("user_note: ".length);
		} else {
			options.push(value);
		}
	}
	return { options, note };
}
