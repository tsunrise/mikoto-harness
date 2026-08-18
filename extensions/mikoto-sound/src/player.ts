import { spawn, type SpawnOptions } from "node:child_process";
import type {
	PlayerProcess,
	PlayerSpawner,
	RuntimeFailure,
} from "./types.ts";

export const AFPLAY_PATH = "/usr/bin/afplay";

const spawnPlayer: PlayerSpawner = (command, args, options) =>
	spawn(command, [...args], options) as PlayerProcess;

export type PlayAudioOptions = {
	readonly spawnProcess?: PlayerSpawner;
	readonly onFailure: (failure: RuntimeFailure) => void;
};

export function playAudio(
	filePath: string,
	options: PlayAudioOptions,
): void {
	const spawnProcess = options.spawnProcess ?? spawnPlayer;
	const spawnOptions: SpawnOptions = {
		detached: true,
		stdio: "ignore",
	};

	let child: PlayerProcess;
	try {
		child = spawnProcess(AFPLAY_PATH, [filePath], spawnOptions);
	} catch (error) {
		options.onFailure({
			key: `afplay:spawn:${filePath}`,
			message: `Unable to start afplay for ${filePath}: ${errorMessage(error)}`,
		});
		return;
	}

	let failed = false;
	child.once("error", (error) => {
		if (failed) return;
		failed = true;
		options.onFailure({
			key: `afplay:spawn:${filePath}`,
			message: `Unable to play ${filePath}: ${error.message}`,
		});
	});
	child.once("close", (code, signal) => {
		if (failed || (code === 0 && signal === null)) return;
		failed = true;
		const outcome =
			signal !== null ? `terminated by ${signal}` : `exited with code ${code}`;
		options.onFailure({
			key: `afplay:exit:${filePath}:${signal ?? code}`,
			message: `Unable to play ${filePath}: afplay ${outcome}.`,
		});
	});

	try {
		child.unref();
	} catch (error) {
		if (failed) return;
		failed = true;
		options.onFailure({
			key: `afplay:unref:${filePath}`,
			message: `Unable to detach afplay for ${filePath}: ${errorMessage(error)}`,
		});
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
