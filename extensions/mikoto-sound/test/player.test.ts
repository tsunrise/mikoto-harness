import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
	AFPLAY_PATH,
	playAudio,
} from "../src/player.ts";
import type {
	PlayerProcess,
	PlayerSpawner,
	RuntimeFailure,
} from "../src/types.ts";

class FakeProcess extends EventEmitter {
	unrefCalls = 0;

	unref(): void {
		this.unrefCalls += 1;
	}
}

describe("audio player", () => {
	it("starts detached afplay without waiting and permits overlap", () => {
		const children = [new FakeProcess(), new FakeProcess()];
		const calls: Array<{
			command: string;
			args: readonly string[];
			options: Parameters<PlayerSpawner>[2];
		}> = [];
		const spawnProcess: PlayerSpawner = (command, args, options) => {
			calls.push({ command, args, options });
			const child = children[calls.length - 1];
			assert.ok(child);
			return child as PlayerProcess;
		};

		const failures: RuntimeFailure[] = [];
		playAudio("/tmp/first.mp3", {
			spawnProcess,
			onFailure: (failure) => failures.push(failure),
		});
		playAudio("/tmp/second.wav", {
			spawnProcess,
			onFailure: (failure) => failures.push(failure),
		});

		assert.equal(calls.length, 2);
		assert.deepEqual(calls[0], {
			command: AFPLAY_PATH,
			args: ["/tmp/first.mp3"],
			options: { detached: true, stdio: "ignore" },
		});
		assert.deepEqual(calls[1]?.args, ["/tmp/second.wav"]);
		assert.deepEqual(children.map((child) => child.unrefCalls), [1, 1]);
		assert.deepEqual(failures, []);
	});

	it("reports synchronous spawn errors", () => {
		const failures: RuntimeFailure[] = [];
		playAudio("/tmp/missing.mp3", {
			spawnProcess() {
				throw new Error("spawn failed");
			},
			onFailure: (failure) => failures.push(failure),
		});

		assert.equal(failures.length, 1);
		assert.match(failures[0]?.message ?? "", /spawn failed/);
	});

	it("reports only one failure when an error is followed by close", () => {
		const child = new FakeProcess();
		const failures: RuntimeFailure[] = [];
		playAudio("/tmp/broken.mp3", {
			spawnProcess: () => child as PlayerProcess,
			onFailure: (failure) => failures.push(failure),
		});

		child.emit("error", new Error("device unavailable"));
		child.emit("close", 1, null);

		assert.equal(failures.length, 1);
		assert.match(failures[0]?.message ?? "", /device unavailable/);
	});

	it("reports non-zero exits and signals", () => {
		const failedExit = new FakeProcess();
		const signalled = new FakeProcess();
		const failures: RuntimeFailure[] = [];
		const children = [failedExit, signalled];

		playAudio("/tmp/exit.mp3", {
			spawnProcess: () => children.shift() as PlayerProcess,
			onFailure: (failure) => failures.push(failure),
		});
		playAudio("/tmp/signal.mp3", {
			spawnProcess: () => children.shift() as PlayerProcess,
			onFailure: (failure) => failures.push(failure),
		});
		failedExit.emit("close", 3, null);
		signalled.emit("close", null, "SIGTERM");

		assert.equal(failures.length, 2);
		assert.match(failures[0]?.message ?? "", /code 3/);
		assert.match(failures[1]?.message ?? "", /SIGTERM/);
	});
});
