import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RuntimeFailure, SoundWarningEntry } from "./types.ts";

export const SOUND_WARNING_ENTRY_TYPE = "mikoto-sound:warning";

export type DiagnosticReporter = {
	reportConfiguration(messages: readonly string[]): void;
	reportRuntime(failure: RuntimeFailure): void;
};

export function createDiagnosticReporter(
	pi: ExtensionAPI,
	log: (message: string) => void = console.error,
): DiagnosticReporter {
	const seenRuntimeIssues = new Set<string>();

	const write = (message: string) => {
		log(`[mikoto-sound] ${message}`);
	};

	const append = (messages: readonly string[]) => {
		const data: SoundWarningEntry = { messages: [...messages] };
		try {
			pi.appendEntry(SOUND_WARNING_ENTRY_TYPE, data);
		} catch {
			// Detached child failures can arrive after reload invalidates this
			// extension runtime. stderr above remains the durable diagnostic.
		}
	};

	return {
		reportConfiguration(messages) {
			if (messages.length === 0) return;
			for (const message of messages) write(message);
			append(messages);
		},

		reportRuntime(failure) {
			if (seenRuntimeIssues.has(failure.key)) return;
			seenRuntimeIssues.add(failure.key);
			write(failure.message);
			append([failure.message]);
		},
	};
}
