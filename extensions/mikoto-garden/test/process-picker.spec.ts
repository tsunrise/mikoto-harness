import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { ProcessPicker } from "../src/process-picker.ts";
import { launchSubject, inputSubject } from "../src/permissions.ts";
import { inertText } from "../../mikoto-policy/src/escalate/ui.ts";
import type { Launch } from "../src/launch.ts";
import type { Job } from "../src/protocol.ts";
import { builtInTheme } from "./theme.ts";

const keys: Record<string, KeyId> = {
  "tui.select.confirm": "enter", "tui.select.cancel": "escape",
  "tui.select.up": "up", "tui.select.down": "down",
  "tui.select.pageUp": "pageUp", "tui.select.pageDown": "pageDown",
};
const job = (id: number): Job => ({
  id, mode: "sandboxed", state: "running", cmd: `printf marker-${id}`, cwd: "/test",
  started: id, stdinOpen: true, exit_code: null, exit_signal: null,
  disclosed: true, collected: false, unread: 7,
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("picker navigates, fetches full detail without consuming output, and confirms only the armed ID", async () => {
  initTheme("dark", false);
  const theme = await builtInTheme("dark");
  const jobs = [job(1), job(2)];
  const reads: (number | undefined)[] = [];
  const stops: number[] = [];
  let closes = 0;
  const picker = new ProcessPicker({ jobs }, undefined, undefined,
    { terminal: { rows: 24 }, requestRender() {} } as never, theme,
    { matches: (data: string, action: string) => matchesKey(data, keys[action]), getKeys: (action: string) => [keys[action]] } as unknown as KeybindingsManager,
    () => { closes++; },
    async (id) => {
      reads.push(id);
      return id === undefined ? { jobs } : {
        jobs: [{ ...jobs.find((j) => j.id === id)!, cmd: "printf '" + "long".repeat(300) + "'\n# exact-end" }],
        tail: "UNCHANGED_PREVIEW",
      };
    },
    async (id) => { stops.push(id); jobs.find((j) => j.id === id)!.state = "exited"; return []; });
  picker.handleInput("\x1b[B"); // Newest first: select ID 1.
  picker.handleInput("\r");
  await tick();
  assert.deepEqual(reads, [1]);
  // Check that the data is reachable, not which page a particular layout puts
  // it on. A different frame/header size must not break the interaction test.
  let viewed = "";
  let previous = "";
  for (let page = 0; page < 100; page++) {
    const frame = picker.render(80).join("\n");
    viewed += frame;
    if (frame === previous) break;
    previous = frame;
    picker.handleInput("\x1b[6~");
  }
  assert.match(viewed, /exact-end/);
  assert.match(viewed, /UNCHANGED_PREVIEW/);
  picker.handleInput("r");
  await tick();
  assert.deepEqual(reads, [1, 1]);
  picker.handleInput("d");
  await tick();
  assert.deepEqual(stops, []);
  picker.handleInput("\x1b"); // Cancel, do not stop.
  picker.handleInput("\r"); // Enter in detail is not approval.
  assert.deepEqual(stops, []);
  picker.handleInput("\x1b[200~");
  picker.handleInput("d");
  picker.handleInput("\r");
  picker.handleInput("\x1b[201~");
  await tick();
  assert.deepEqual(stops, []);
  picker.handleInput("d");
  await tick();
  picker.handleInput("\r");
  picker.handleInput("\r"); // No double dispatch during asynchronous stop.
  await tick();
  assert.deepEqual(stops, [1]);
  picker.handleInput("\x1b"); // Back to list.
  await tick();
  picker.handleInput("\x1b");
  assert.equal(closes, 1);
  assert.equal(jobs[0]!.unread, 7);
});

test("picker failure/expired ID is inert and does not leak executor exception details", async () => {
  const picker = new ProcessPicker({ jobs: [job(1)] }, undefined, undefined,
    { terminal: { rows: 24 }, requestRender() {} } as never, await builtInTheme("dark"),
    { matches: (data: string, action: string) => matchesKey(data, keys[action]), getKeys: (action: string) => [keys[action]] } as unknown as KeybindingsManager,
    () => {}, async () => { throw new Error("private-token"); }, async () => { assert.fail("must not stop"); });
  picker.handleInput("d");
  await tick();
  picker.handleInput("\r");
  await tick();
  assert.doesNotMatch(picker.render(100).join("\n"), /private-token/);
  let closes = 0;
  const unavailableDetail = new ProcessPicker({ jobs: [job(1)] }, undefined, 1,
    { terminal: { rows: 24 }, requestRender() {} } as never, await builtInTheme("dark"),
    { matches: (data: string, action: string) => matchesKey(data, keys[action]), getKeys: (action: string) => [keys[action]] } as unknown as KeybindingsManager,
    () => { closes++; }, async () => { throw new Error("gone"); }, async () => []);
  unavailableDetail.handleInput("\x1b");
  await tick();
  unavailableDetail.handleInput("\x1b");
  assert.equal(closes, 1, "failed refresh cannot trap the user in detail");
});

test("approval scope preserves command, authority and inspectable input/control bytes", () => {
  const launch = { cmd: "printf 'safe\\n'", cwd: "/test", shell: "/bin/sh", login: false, stdin: false } as Launch;
  const scope = launchSubject(launch).map(inertText);
  assert.ok(scope.some((line) => line.includes(launch.cmd)));
  assert.match(scope.join("\n"), /\/bin\/sh -c/);
  assert.match(scope.join("\n"), /stdin closed/);
  assert.match(scope.join("\n"), /host authority/);
  const multilineScope = launchSubject({
    ...launch,
    cmd: "\nprintf hi\u001b[31m",
  }).map(inertText);
  assert.ok(multilineScope.some((line) => line.includes("Line 1: (empty)")));
  assert.ok(multilineScope.some((line) => line.includes("Line 2: printf hi\\u{1b}[31m")));
  assert.doesNotMatch(multilineScope.join("\n"), /\\u\{a\}/);
  const input = inputSubject(job(1), { kind: "write", chars: "line\n" }).map(inertText).join("\n");
  assert.match(input, /5 bytes/);
  assert.ok(input.includes("line\\u{a}"));
});
