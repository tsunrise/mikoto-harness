import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	formatZodError,
	soundConfigSchema,
} from "../src/schema.ts";

describe("Zod config schema", () => {
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
