import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { MikotoEventPayload } from "mikoto-types";
import {
	inspectAudioWithAfinfo,
	loadSoundConfig,
	type LoadSoundConfigOptions,
} from "./config.ts";
import {
	createDiagnosticReporter,
	SOUND_WARNING_ENTRY_TYPE,
} from "./diagnostics.ts";
import { playAudio } from "./player.ts";
import type {
	AudioInspector,
	ConfigFileSystem,
	PlayerSpawner,
	SoundWarningEntry,
} from "./types.ts";

export const SOUND_EVENT_NAME = "mikoto-sound:sound";
export const DEFAULT_SOUND_EFFECT = "require-attention";
export const COMPLETED_SOUND_EFFECT = "completed";
export const SOUND_CONFIG_FILE = "mikoto-sound.json";

export type MikotoSoundOptions = {
	readonly platform?: NodeJS.Platform;
	readonly agentDir?: string;
	readonly homeDir?: string;
	readonly inspectAudio?: AudioInspector;
	readonly fileSystem?: ConfigFileSystem;
	readonly spawnProcess?: PlayerSpawner;
	readonly log?: (message: string) => void;
};

export default function mikotoSound(
	pi: ExtensionAPI,
	options: MikotoSoundOptions = {},
): void {
	if ((options.platform ?? process.platform) !== "darwin") return;

	let effects = createBundledEffects();
	const diagnostics = createDiagnosticReporter(pi, options.log);

	pi.registerEntryRenderer<SoundWarningEntry>(
		SOUND_WARNING_ENTRY_TYPE,
		(entry, _renderOptions, theme) => {
			const messages = entry.data?.messages;
			if (
				!Array.isArray(messages) ||
				messages.length === 0 ||
				!messages.every((message) => typeof message === "string")
			) {
				return undefined;
			}

			const lines = [
				theme.fg("warning", theme.bold("Mikoto Sound warning")),
				...messages.map((message) => theme.fg("muted", `- ${message}`)),
			];
			return new Text(lines.join("\n"), 1, 0);
		},
	);

	const playEffect = (effect: string): void => {
		const audioPath = effects.get(effect);
		if (!audioPath) {
			diagnostics.reportRuntime({
				key: `unknown-effect:${effect}`,
				message: `Unknown sound effect: ${effect}`,
			});
			return;
		}

		playAudio(audioPath, {
			spawnProcess: options.spawnProcess,
			onFailure: diagnostics.reportRuntime,
		});
	};

	pi.on("session_start", async () => {
		const configOptions: LoadSoundConfigOptions = {
			configPath: path.join(
				options.agentDir ?? getAgentDir(),
				SOUND_CONFIG_FILE,
			),
			defaults: createBundledEffects(),
			inspectAudio: options.inspectAudio ?? inspectAudioWithAfinfo,
			fileSystem: options.fileSystem,
			homeDir: options.homeDir ?? os.homedir(),
		};
		const loaded = await loadSoundConfig(configOptions);
		effects = loaded.effects;
		diagnostics.reportConfiguration(loaded.diagnostics);
	});

	// Handle event from other extensions
	pi.events.on(SOUND_EVENT_NAME, (data) => {
		const event = data as MikotoEventPayload<typeof SOUND_EVENT_NAME>;
		playEffect(event.effect ?? DEFAULT_SOUND_EFFECT);
	});

	// Handle built-in turn-finish event
	pi.on("agent_settled", () => {
		playEffect(COMPLETED_SOUND_EFFECT);
	});
}

export function createBundledEffects(): Map<string, string> {
	return new Map([
		[
			DEFAULT_SOUND_EFFECT,
			fileURLToPath(new URL("../resources/bip-bop-03.mp3", import.meta.url)),
		],
		[
			COMPLETED_SOUND_EFFECT,
			fileURLToPath(new URL("../resources/bip-bop-01.mp3", import.meta.url)),
		],
	]);
}

export {
	SOUND_WARNING_ENTRY_TYPE,
};
