import { z } from "zod";
import type { MikotoSoundEvent } from "mikoto-types";

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

export const soundEventObjectSchema = z.looseObject({
	effect: nonBlankEffectName.optional(),
});

export const soundEventSchema = z.union([
	z.undefined(),
	soundEventObjectSchema,
]);

type Assert<Condition extends true> = Condition;
type EventSchemaMatchesSharedType = Assert<
	z.output<typeof soundEventObjectSchema> extends MikotoSoundEvent
		? true
		: false
>;
type SharedTypeMatchesEventSchema = Assert<
	MikotoSoundEvent extends z.input<typeof soundEventObjectSchema>
		? true
		: false
>;

export function formatZodError(error: z.ZodError): string {
	return z.prettifyError(error);
}
