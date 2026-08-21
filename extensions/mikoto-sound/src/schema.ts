import { z } from "zod";

const nonBlankEffectName = z
	.string()
	.refine((value) => value.trim().length > 0, {
		message: "Effect names must not be blank.",
	});

const nonBlankPath = z
	.string()
	.refine((value) => value.trim().length > 0, {
		message: "Sound paths must not be blank.",
	});

export const soundConfigSchema = z.strictObject({
	effects: z.record(nonBlankEffectName, nonBlankPath),
});

export function formatZodError(error: z.ZodError): string {
	return z.prettifyError(error);
}
