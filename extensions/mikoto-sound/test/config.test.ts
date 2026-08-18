import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	inspectAudioWithAfinfo,
	loadSoundConfig,
	resolveSoundPath,
} from "../src/config.ts";
import { createBundledEffects } from "../src/index.ts";

async function temporaryDirectory(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "mikoto-sound-config-"));
}

describe("sound configuration", () => {
	it("uses bundled effects silently when the config is absent", async () => {
		const directory = await temporaryDirectory();
		try {
			const defaults = createBundledEffects();
			const loaded = await loadSoundConfig({
				configPath: path.join(directory, "missing.json"),
				defaults,
				inspectAudio: async () => ({ supported: true }),
			});
			assert.deepEqual([...loaded.effects], [...defaults]);
			assert.deepEqual(loaded.diagnostics, []);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("loads valid siblings, custom formats, and built-in overrides", async () => {
		const directory = await temporaryDirectory();
		try {
			const completedPath = path.join(directory, "new-completed.aiff");
			const customPath = path.join(directory, "custom.wav");
			await Promise.all([
				writeFile(completedPath, "audio"),
				writeFile(customPath, "audio"),
			]);
			const configPath = path.join(directory, "mikoto-sound.json");
			await writeFile(
				configPath,
				JSON.stringify({
					effects: {
						completed: "./new-completed.aiff",
						custom: "./custom.wav",
					},
				}),
			);

			const inspected: string[] = [];
			const loaded = await loadSoundConfig({
				configPath,
				defaults: createBundledEffects(),
				inspectAudio: async (filePath) => {
					inspected.push(filePath);
					return { supported: true };
				},
			});

			assert.equal(loaded.effects.get("completed"), completedPath);
			assert.equal(loaded.effects.get("custom"), customPath);
			assert.ok(loaded.effects.has("require-attention"));
			assert.deepEqual(inspected, [completedPath, customPath]);
			assert.deepEqual(loaded.diagnostics, []);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects the whole config when its Zod schema is invalid", async () => {
		const directory = await temporaryDirectory();
		try {
			const validPath = path.join(directory, "valid.caf");
			await writeFile(validPath, "audio");
			const configPath = path.join(directory, "mikoto-sound.json");
			await writeFile(
				configPath,
				JSON.stringify({
					unexpected: true,
					effects: {
						valid: "./valid.caf",
						"": "./valid.caf",
						badValue: 42,
					},
				}),
			);

			const defaults = createBundledEffects();
			const loaded = await loadSoundConfig({
				configPath,
				defaults,
				inspectAudio: async () => {
					throw new Error("schema failures must precede file validation");
				},
			});

			assert.deepEqual([...loaded.effects], [...defaults]);
			assert.equal(loaded.diagnostics.length, 1);
			assert.match(loaded.diagnostics[0] ?? "", /Invalid .*mikoto-sound\.json/);
			assert.match(loaded.diagnostics[0] ?? "", /unrecognized key/i);
			assert.match(loaded.diagnostics[0] ?? "", /effects/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("collects file errors and atomically rejects all overrides", async () => {
		const directory = await temporaryDirectory();
		try {
			const validPath = path.join(directory, "valid.caf");
			const unsupportedPath = path.join(directory, "unsupported.bin");
			const directoryPath = path.join(directory, "not-a-file");
			await Promise.all([
				writeFile(validPath, "audio"),
				writeFile(unsupportedPath, "not audio"),
				mkdir(directoryPath),
			]);
			const configPath = path.join(directory, "mikoto-sound.json");
			await writeFile(
				configPath,
				JSON.stringify({
					effects: {
						valid: "./valid.caf",
						completed: "./missing.mp3",
						unsupported: "./unsupported.bin",
						directory: "./not-a-file",
					},
				}),
			);

			const defaults = createBundledEffects();
			const loaded = await loadSoundConfig({
				configPath,
				defaults,
				inspectAudio: async (filePath) =>
					filePath === unsupportedPath
						? { supported: false, reason: "unsupported by afinfo" }
						: { supported: true },
			});

			assert.deepEqual([...loaded.effects], [...defaults]);
			assert.equal(loaded.effects.has("valid"), false);
			assert.equal(loaded.effects.get("completed"), defaults.get("completed"));
			assert.equal(loaded.effects.has("unsupported"), false);
			assert.equal(loaded.effects.has("directory"), false);
			assert.equal(loaded.diagnostics.length, 3);
			assert.match(loaded.diagnostics.join("\n"), /missing\.mp3/);
			assert.match(loaded.diagnostics.join("\n"), /not a regular file/);
			assert.match(loaded.diagnostics.join("\n"), /unsupported by afinfo/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("falls back after malformed JSON or an invalid root", async () => {
		const directory = await temporaryDirectory();
		try {
			const configPath = path.join(directory, "mikoto-sound.json");
			const defaults = createBundledEffects();

			await writeFile(configPath, "{");
			const malformed = await loadSoundConfig({
				configPath,
				defaults,
				inspectAudio: async () => ({ supported: true }),
			});
			assert.deepEqual([...malformed.effects], [...defaults]);
			assert.equal(malformed.diagnostics.length, 1);
			assert.match(malformed.diagnostics[0] ?? "", /Unable to parse/);

			await writeFile(configPath, "[]");
			const invalidRoot = await loadSoundConfig({
				configPath,
				defaults,
				inspectAudio: async () => ({ supported: true }),
			});
			assert.deepEqual([...invalidRoot.effects], [...defaults]);
			assert.equal(invalidRoot.diagnostics.length, 1);
			assert.match(invalidRoot.diagnostics[0] ?? "", /expected object/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("resolves relative, absolute, and home-relative paths", () => {
		const configPath = "/Users/test/.pi/agent/mikoto-sound.json";
		assert.equal(
			resolveSoundPath("sounds/done.wav", configPath, "/Users/test"),
			"/Users/test/.pi/agent/sounds/done.wav",
		);
		assert.equal(
			resolveSoundPath("~/Sounds/done.wav", configPath, "/Users/test"),
			"/Users/test/Sounds/done.wav",
		);
		assert.equal(
			resolveSoundPath("/tmp/done.wav", configPath, "/Users/test"),
			"/tmp/done.wav",
		);
	});
});

it(
	"bundled resources are accepted by macOS afinfo",
	{ skip: process.platform !== "darwin" },
	async () => {
		for (const filePath of createBundledEffects().values()) {
			assert.deepEqual(await inspectAudioWithAfinfo(filePath), {
				supported: true,
			});
		}
	},
);
