import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type {
	AudioInspection,
	AudioInspector,
	ConfigFileSystem,
	ParsedSoundConfig,
} from "./types.ts";
import {
	formatZodError,
	soundConfigSchema,
} from "./schema.ts";

const AFINFO_PATH = "/usr/bin/afinfo";
export const AFINFO_TIMEOUT_MS = 5_000;

const nodeFileSystem: ConfigFileSystem = {
	readFile: (filePath, encoding) => readFile(filePath, encoding),
	stat,
	access,
};

export type LoadSoundConfigOptions = {
	readonly configPath: string;
	readonly defaults: ReadonlyMap<string, string>;
	readonly inspectAudio?: AudioInspector;
	readonly fileSystem?: ConfigFileSystem;
	readonly homeDir?: string;
};

export type LoadedSoundConfig = {
	readonly effects: Map<string, string>;
	readonly diagnostics: readonly string[];
};

export async function loadSoundConfig(
	options: LoadSoundConfigOptions,
): Promise<LoadedSoundConfig> {
	const effects = new Map(options.defaults);
	const diagnostics: string[] = [];
	const fileSystem = options.fileSystem ?? nodeFileSystem;
	const inspectAudio = options.inspectAudio ?? inspectAudioWithAfinfo;

	let source: string;
	try {
		source = await fileSystem.readFile(options.configPath, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { effects, diagnostics };
		diagnostics.push(
			`Unable to read ${options.configPath}: ${errorMessage(error)}`,
		);
		return { effects, diagnostics };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		diagnostics.push(
			`Unable to parse ${options.configPath}: ${errorMessage(error)}`,
		);
		return { effects, diagnostics };
	}

	const parsedConfig = soundConfigSchema.safeParse(parsed);
	if (!parsedConfig.success) {
		diagnostics.push(
			`Invalid ${options.configPath}:\n${formatZodError(parsedConfig.error)}`,
		);
		return { effects, diagnostics };
	}

	const config: ParsedSoundConfig = parsedConfig.data;
	const validatedEffects = new Map<string, string>();
	for (const [effect, configuredPath] of Object.entries(config.effects)) {
		const audioPath = resolveSoundPath(
			configuredPath,
			options.configPath,
			options.homeDir ?? os.homedir(),
		);

		let fileStats: Pick<import("node:fs").Stats, "isFile">;
		try {
			fileStats = await fileSystem.stat(audioPath);
		} catch (error) {
			diagnostics.push(
				`Effect "${effect}" cannot use ${audioPath}: ${errorMessage(error)}`,
			);
			continue;
		}
		if (!fileStats.isFile()) {
			diagnostics.push(
				`Effect "${effect}" cannot use ${audioPath}: not a regular file.`,
			);
			continue;
		}

		try {
			await fileSystem.access(audioPath, fsConstants.R_OK);
		} catch (error) {
			diagnostics.push(
				`Effect "${effect}" cannot read ${audioPath}: ${errorMessage(error)}`,
			);
			continue;
		}

		let inspection: AudioInspection;
		try {
			inspection = await inspectAudio(audioPath);
		} catch (error) {
			inspection = { supported: false, reason: errorMessage(error) };
		}
		if (!inspection.supported) {
			diagnostics.push(
				`Effect "${effect}" cannot use ${audioPath}: ${inspection.reason}`,
			);
			continue;
		}

		validatedEffects.set(effect, audioPath);
	}

	if (diagnostics.length > 0) return { effects, diagnostics };
	for (const [effect, audioPath] of validatedEffects) {
		effects.set(effect, audioPath);
	}
	return { effects, diagnostics };
}

export function resolveSoundPath(
	configuredPath: string,
	configPath: string,
	homeDir: string,
): string {
	let expanded = configuredPath;
	if (configuredPath === "~") {
		expanded = homeDir;
	} else if (configuredPath.startsWith("~/")) {
		expanded = path.join(homeDir, configuredPath.slice(2));
	}
	return path.isAbsolute(expanded)
		? path.normalize(expanded)
		: path.resolve(path.dirname(configPath), expanded);
}

export function inspectAudioWithAfinfo(
	filePath: string,
	timeoutMs = AFINFO_TIMEOUT_MS,
): Promise<AudioInspection> {
	return new Promise((resolve) => {
		execFile(
			AFINFO_PATH,
			["-b", filePath],
			{ timeout: timeoutMs },
			(error, _stdout, stderr) => {
				if (!error) {
					resolve({ supported: true });
					return;
				}
				const detail = stderr.trim() || error.message;
				resolve({
					supported: false,
					reason: `unsupported by afinfo (${detail})`,
				});
			},
		);
	});
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
