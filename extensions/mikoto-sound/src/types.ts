import type { Stats } from "node:fs";
import type { SpawnOptions } from "node:child_process";
import type { z } from "zod";
import type { soundConfigSchema } from "./schema.ts";

export type ParsedSoundConfig = z.infer<typeof soundConfigSchema>;

export type AudioInspection =
	| { readonly supported: true }
	| { readonly supported: false; readonly reason: string };

export type AudioInspector = (filePath: string) => Promise<AudioInspection>;

export type ConfigFileSystem = {
	readFile(filePath: string, encoding: "utf8"): Promise<string>;
	stat(filePath: string): Promise<Pick<Stats, "isFile">>;
	access(filePath: string, mode: number): Promise<void>;
};

export type PlayerProcess = {
	unref(): void;
	once(event: "error", listener: (error: Error) => void): unknown;
	once(
		event: "close",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): unknown;
};

export type PlayerSpawner = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => PlayerProcess;

export type RuntimeFailure = {
	readonly key: string;
	readonly message: string;
};

export type SoundWarningEntry = {
	readonly messages: readonly string[];
};
