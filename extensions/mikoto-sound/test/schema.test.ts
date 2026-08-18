import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatZodError,
	soundConfigSchema,
	soundEventSchema,
} from "../src/schema.ts";

describe("Zod runtime schemas", () => {
	it("strictly validates the complete config shape", () => {
		assert.equal(
			soundConfigSchema.safeParse({
				effects: { completed: "./done.wav" },
			}).success,
			true,
		);
		assert.equal(
			soundConfigSchema.safeParse({
				effects: {},
				unexpected: true,
			}).success,
			false,
		);
		assert.equal(
			soundConfigSchema.safeParse({
				effects: { completed: 42 },
			}).success,
			false,
		);
		assert.equal(
			soundConfigSchema.safeParse({
				effects: { " ": "./done.wav" },
			}).success,
			false,
		);
		assert.equal(
			soundConfigSchema.safeParse({
				effects: { completed: " " },
			}).success,
			false,
		);
	});

	it("preserves non-blank names and paths exactly", () => {
		const parsed = soundConfigSchema.parse({
			effects: { " custom ": " ./sound file.wav " },
		});
		assert.deepEqual(parsed, {
			effects: { " custom ": " ./sound file.wav " },
		});
	});

	it("accepts tolerant sound events while rejecting malformed effects", () => {
		assert.equal(soundEventSchema.safeParse(undefined).success, true);
		assert.equal(soundEventSchema.safeParse({}).success, true);
		assert.equal(
			soundEventSchema.safeParse({
				effect: "custom",
				unrelated: true,
			}).success,
			true,
		);
		assert.equal(soundEventSchema.safeParse(null).success, false);
		assert.equal(soundEventSchema.safeParse({ effect: 1 }).success, false);
		assert.equal(soundEventSchema.safeParse({ effect: " " }).success, false);
	});

	it("formats path-aware validation issues", () => {
		const result = soundConfigSchema.safeParse({
			effects: { completed: 42 },
		});
		assert.equal(result.success, false);
		if (result.success) return;
		const formatted = formatZodError(result.error);
		assert.match(formatted, /expected string/i);
		assert.match(formatted, /effects\.completed/);
	});
});
