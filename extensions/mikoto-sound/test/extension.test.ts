import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import mikotoSound, {
	COMPLETED_SOUND_EFFECT,
	DEFAULT_SOUND_EFFECT,
	SOUND_EVENT_NAME,
	SOUND_WARNING_ENTRY_TYPE,
	createBundledEffects,
} from "../src/index.ts";
import type {
	PlayerProcess,
	PlayerSpawner,
	SoundWarningEntry,
} from "../src/types.ts";

type Handler = (event?: unknown, context?: unknown) => unknown;

class FakeProcess extends EventEmitter {
	unref(): void {}
}

function setupApi(): {
	api: ExtensionAPI;
	handlers: Map<string, Handler>;
	eventListeners: Map<string, (data: unknown) => void>;
	entries: Array<{ customType: string; data: unknown }>;
	renderer?: (
		entry: { data?: SoundWarningEntry },
		options: unknown,
		theme: {
			fg(name: string, text: string): string;
			bold(text: string): string;
		},
	) => { render(width: number): string[] } | undefined;
} {
	const handlers = new Map<string, Handler>();
	const eventListeners = new Map<string, (data: unknown) => void>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const result = {
		api: undefined as unknown as ExtensionAPI,
		handlers,
		eventListeners,
		entries,
		renderer: undefined as ReturnType<typeof setupApi>["renderer"],
	};
	result.api = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerEntryRenderer(_customType: string, renderer: unknown) {
			result.renderer = renderer as typeof result.renderer;
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		events: {
			emit() {},
			on(channel: string, handler: (data: unknown) => void) {
				eventListeners.set(channel, handler);
				return () => eventListeners.delete(channel);
			},
		},
	} as unknown as ExtensionAPI;
	return result;
}

describe("Mikoto Sound extension", () => {
	it("registers nothing outside macOS", () => {
		const setup = setupApi();
		mikotoSound(setup.api, { platform: "linux" });
		assert.deepEqual([...setup.handlers], []);
		assert.deepEqual([...setup.eventListeners], []);
		assert.equal(setup.renderer, undefined);
	});

	it("plays default, named, and settled effects without a Pi mode guard", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "mikoto-sound-ext-"));
		try {
			const spawned: string[] = [];
			const spawnProcess: PlayerSpawner = (_command, args) => {
				spawned.push(args[0] ?? "");
				return new FakeProcess() as PlayerProcess;
			};
			const setup = setupApi();
			mikotoSound(setup.api, {
				platform: "darwin",
				agentDir: directory,
				spawnProcess,
				log() {},
			});

			assert.ok(setup.handlers.has("session_start"));
			assert.ok(setup.handlers.has("agent_settled"));
			assert.ok(setup.eventListeners.has(SOUND_EVENT_NAME));
			assert.ok(setup.renderer);
			await setup.handlers.get("session_start")?.();

			const listener = setup.eventListeners.get(SOUND_EVENT_NAME);
			assert.ok(listener);
			listener({});
			listener({ effect: COMPLETED_SOUND_EFFECT });
			setup.handlers.get("agent_settled")?.({}, { mode: "json" });

			const bundled = createBundledEffects();
			assert.deepEqual(spawned, [
				bundled.get(DEFAULT_SOUND_EFFECT),
				bundled.get(COMPLETED_SOUND_EFFECT),
				bundled.get(COMPLETED_SOUND_EFFECT),
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("loads custom effects from a valid strict config", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "mikoto-sound-ext-"));
		try {
			const audioPath = path.join(directory, "custom.wav");
			await writeFile(audioPath, "audio");
			await writeFile(
				path.join(directory, "mikoto-sound.json"),
				JSON.stringify({
					effects: {
						custom: "./custom.wav",
					},
				}),
			);

			const spawned: string[] = [];
			const logs: string[] = [];
			const setup = setupApi();
			mikotoSound(setup.api, {
				platform: "darwin",
				agentDir: directory,
				inspectAudio: async () => ({ supported: true }),
				spawnProcess: (_command, args) => {
					spawned.push(args[0] ?? "");
					return new FakeProcess() as PlayerProcess;
				},
				log: (message) => logs.push(message),
			});

			await setup.handlers.get("session_start")?.();
			setup.eventListeners.get(SOUND_EVENT_NAME)?.({ effect: "custom" });

			assert.deepEqual(spawned, [audioPath]);
			assert.deepEqual(setup.entries, []);
			assert.deepEqual(logs, []);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("summarizes strict Zod configuration failures", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "mikoto-sound-ext-"));
		try {
			await writeFile(
				path.join(directory, "mikoto-sound.json"),
				JSON.stringify({
					unexpected: true,
					effects: {},
				}),
			);

			const logs: string[] = [];
			const setup = setupApi();
			mikotoSound(setup.api, {
				platform: "darwin",
				agentDir: directory,
				log: (message) => logs.push(message),
			});

			await setup.handlers.get("session_start")?.();
			assert.equal(setup.entries.length, 1);
			assert.equal(setup.entries[0]?.customType, SOUND_WARNING_ENTRY_TYPE);
			const warning = setup.entries[0]?.data as SoundWarningEntry;
			assert.equal(warning.messages.length, 1);
			assert.match(warning.messages[0] ?? "", /unrecognized key/i);
			assert.equal(logs.length, 1);

			const rendered = setup.renderer?.(
				{ data: warning },
				{},
				{
					fg(_name, text) {
						return text;
					},
					bold(text) {
						return text;
					},
				},
			);
			assert.match(rendered?.render(100).join("\n") ?? "", /Mikoto Sound warning/);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("treats blank names as unknown effects and warns once", () => {
		const setup = setupApi();
		const logs: string[] = [];
		mikotoSound(setup.api, {
			platform: "darwin",
			agentDir: "/tmp",
			spawnProcess: () => new FakeProcess() as PlayerProcess,
			log: (message) => logs.push(message),
		});
		const listener = setup.eventListeners.get(SOUND_EVENT_NAME);
		assert.ok(listener);

		listener({ effect: " " });
		listener({ effect: " " });

		assert.equal(logs.length, 1);
		assert.equal(setup.entries.length, 1);
		assert.match(logs[0] ?? "", /Unknown sound effect/);
	});
});
