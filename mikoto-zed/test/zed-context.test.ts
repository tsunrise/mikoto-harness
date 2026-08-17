import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import mikotoZed, {
	addContextToFooter,
	findZedAncestorPid,
	formatContext,
	formatFooterContext,
	isZedTerminalEnvironment,
	offsetsToSelection,
	resolveZedContext,
	type ZedTerminal,
	utf8ByteOffsetToStringIndex,
	ZED_CONTEXT_POLL_INTERVAL_MS,
} from "../src/index.ts";

initTheme("dark", false);
const ACTIVE_ZED_TERMINAL: ZedTerminal = { isActive: () => true };

function sqlQuote(value: string) {
	return `'${value.replaceAll("'", "''")}'`;
}

function fixture(options: {
	contents?: string;
	workspacePath?: string;
	selections?: Array<{ start: number; end: number }>;
}) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "mikoto-zed-"));
	const dbPath = path.join(dir, "zed.sqlite");
	const filePath = path.join(dir, "file.ts");
	const contents = options.contents ?? "one\ntwo\nthree";
	const workspacePath = options.workspacePath ?? dir;
	const sql = [
		"create table workspaces (workspace_id integer, paths text, timestamp text);",
		"create table panes (pane_id integer, workspace_id integer, active integer);",
		"create table items (item_id integer, workspace_id integer, pane_id integer, active integer, kind text);",
		"create table editors (item_id integer, workspace_id integer, buffer_path text, contents text);",
		"create table editor_selections (editor_id integer, workspace_id integer, start integer, end integer);",
		`insert into workspaces values (1, ${sqlQuote(workspacePath)}, '2026-01-01');`,
		"insert into panes values (1, 1, 1);",
		"insert into items values (1, 1, 1, 1, 'Editor');",
		`insert into editors values (1, 1, ${sqlQuote(filePath)}, ${sqlQuote(contents)});`,
		...(options.selections ?? [{ start: 4, end: 7 }]).map(
			(selection) => `insert into editor_selections values (1, 1, ${selection.start}, ${selection.end});`,
		),
	].join("\n");
	execFileSync("sqlite3", [dbPath], { input: sql });
	return { dir, dbPath, filePath, contents };
}

function withDb<T>(dbPath: string, run: () => T) {
	const previous = process.env.PI_ZED_DB;
	process.env.PI_ZED_DB = dbPath;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env.PI_ZED_DB;
		else process.env.PI_ZED_DB = previous;
	}
}

function byteOffset(text: string, stringIndex: number) {
	return Buffer.byteLength(text.slice(0, stringIndex), "utf8");
}

async function waitFor(check: () => boolean, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function tuiContext(cwd: string) {
	let footer: { render(width: number): string[]; dispose?(): void } | undefined;
	const statuses: Array<string | undefined> = [];
	let renderRequests = 0;
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		italic(text: string) {
			return `\x1b[3m${text}\x1b[23m`;
		},
	};
	const footerData = {
		getGitBranch() {
			return "main";
		},
		getExtensionStatuses() {
			return new Map<string, string>();
		},
		getAvailableProviderCount() {
			return 1;
		},
		onBranchChange() {
			return () => {};
		},
	};
	const ctx = {
		cwd,
		mode: "tui",
		model: undefined,
		thinkingLevel: undefined,
		modelRegistry: { isUsingOAuth() { return false; } },
		sessionManager: {
			getCwd() { return cwd; },
			getEntries() { return []; },
			getSessionName() { return undefined; },
		},
		getContextUsage() { return undefined; },
		ui: {
			setStatus(_id: string, text: string | undefined) {
				statuses.push(text);
			},
			setFooter(factory: Function | undefined) {
				footer?.dispose?.();
				footer = factory?.(
					{ requestRender() { renderRequests += 1; } },
					theme,
					footerData,
				);
			},
		},
	};
	return {
		ctx,
		statuses,
		get renderRequests() { return renderRequests; },
		render(width = 120) {
			return footer?.render(width) ?? [];
		},
	};
}

function stripAnsi(text: string) {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("resolves the active selection in a containing workspace", () => {
	const value = fixture({});
	try {
		const result = withDb(value.dbPath, () => resolveZedContext(path.join(value.dir, "packages", "app")));
		assert.equal(result.type, "context");
		if (result.type !== "context") return;
		assert.equal(result.context.filePath, value.filePath);
		assert.equal(result.context.ranges[0]?.text, "two");
		assert.deepEqual(result.context.ranges[0]?.selection, {
			start: { line: 2, character: 1 },
			end: { line: 2, character: 4 },
		});
	} finally {
		rmSync(value.dir, { recursive: true, force: true });
	}
});

test("does not leak context from an unrelated Zed workspace", () => {
	const value = fixture({});
	try {
		const result = withDb(value.dbPath, () => resolveZedContext(path.join(path.dirname(value.dir), "other")));
		assert.deepEqual(result, { type: "empty" });
	} finally {
		rmSync(value.dir, { recursive: true, force: true });
	}
});

test("handles multiple, reversed, UTF-8 byte selections", () => {
	const contents = "😀\none\nвыбор\nlast";
	const firstStart = contents.indexOf("one");
	const secondStart = contents.indexOf("выбор");
	const value = fixture({
		contents,
		selections: [
			{ start: byteOffset(contents, secondStart + "выбор".length), end: byteOffset(contents, secondStart) },
			{ start: byteOffset(contents, firstStart), end: byteOffset(contents, firstStart + 3) },
		],
	});
	try {
		const result = withDb(value.dbPath, () => resolveZedContext(value.dir));
		assert.equal(result.type, "context");
		if (result.type !== "context") return;
		assert.deepEqual(result.context.ranges.map((range) => range.text), ["one", "выбор"]);
		assert.equal(result.context.ranges[1]?.selection.start.line, 3);
	} finally {
		rmSync(value.dir, { recursive: true, force: true });
	}
});

test("keeps cursor-only context without injecting the full file", () => {
	const value = fixture({ selections: [{ start: 5, end: 5 }] });
	try {
		const result = withDb(value.dbPath, () => resolveZedContext(value.dir));
		assert.equal(result.type, "context");
		if (result.type !== "context") return;
		const formatted = formatContext(result.context);
		assert.match(formatted, /Selection 1: 2:2-2:2 \(cursor\)/);
		assert.doesNotMatch(formatted, /one\ntwo\nthree/);
	} finally {
		rmSync(value.dir, { recursive: true, force: true });
	}
});

test("injects current Zed context as a hidden turn message", async () => {
	const value = fixture({});
	const handlers = new Map<string, Function>();
	const pi = {
		registerTool() {},
		registerCommand() {},
		on(name: string, handler: Function) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	mikotoZed(pi, { terminal: ACTIVE_ZED_TERMINAL });

	const previous = process.env.PI_ZED_DB;
	process.env.PI_ZED_DB = value.dbPath;
	try {
		const handler = handlers.get("before_agent_start");
		assert.ok(handler);
		const result = await handler(
			{},
			{
				cwd: value.dir,
				ui: { setStatus() {} },
			},
		) as { message?: { customType: string; content: string; display: boolean } };
		assert.equal(result.message?.customType, "zed-context");
		assert.equal(result.message?.display, false);
		assert.match(result.message?.content ?? "", /Selection 1: 2:1-2:4/);
		assert.match(result.message?.content ?? "", /two/);
	} finally {
		if (previous === undefined) delete process.env.PI_ZED_DB;
		else process.env.PI_ZED_DB = previous;
		rmSync(value.dir, { recursive: true, force: true });
	}
});

test("shows the exact selected line and preserves it while Zed's terminal is focused", async () => {
	const value = fixture({});
	const handlers = new Map<string, Function>();
	const pi = {
		registerTool() {},
		registerCommand() {},
		on(name: string, handler: Function) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	mikotoZed(pi, { terminal: ACTIVE_ZED_TERMINAL });

	const previous = process.env.PI_ZED_DB;
	process.env.PI_ZED_DB = value.dbPath;
	const tui = tuiContext(value.dir);
	let started = false;
	try {
		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart);
		await sessionStart({}, tui.ctx);
		started = true;
		assert.match(stripAnsi(tui.render()[0] ?? ""), / \(main\) file\.ts:2$/);
		assert.match(tui.render()[0] ?? "", /\x1b\[3mfile\.ts:2\x1b\[23m/);
		assert.deepEqual(tui.statuses, []);

		execFileSync("sqlite3", [value.dbPath, "update panes set active = 0 where pane_id = 1"]);

		const beforeAgentStart = handlers.get("before_agent_start");
		assert.ok(beforeAgentStart);
		const result = await beforeAgentStart({}, tui.ctx) as { message?: { content: string } };
		assert.match(result.message?.content ?? "", /Selection 1: 2:1-2:4/);
		assert.match(stripAnsi(tui.render()[0] ?? ""), / file\.ts:2$/);
	} finally {
		if (started) await handlers.get("session_shutdown")?.({}, tui.ctx);
		if (previous === undefined) delete process.env.PI_ZED_DB;
		else process.env.PI_ZED_DB = previous;
		rmSync(value.dir, { recursive: true, force: true });
	}
});

test("polls Zed and updates the TUI when the active file and selection change", async () => {
	const value = fixture({});
	const handlers = new Map<string, Function>();
	const pi = {
		registerTool() {},
		registerCommand() {},
		on(name: string, handler: Function) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	mikotoZed(pi, { terminal: ACTIVE_ZED_TERMINAL });

	const previous = process.env.PI_ZED_DB;
	process.env.PI_ZED_DB = value.dbPath;
	const tui = tuiContext(value.dir);
	let started = false;
	try {
		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart);
		await sessionStart({}, tui.ctx);
		started = true;

		const secondPath = path.join(value.dir, "second.ts");
		const secondContents = "alpha\nbeta\ngamma";
		const start = byteOffset(secondContents, secondContents.indexOf("gamma"));
		const end = byteOffset(secondContents, secondContents.length);
		execFileSync("sqlite3", [value.dbPath], {
			input: [
				"begin;",
				"update items set active = 0 where item_id = 1 and workspace_id = 1;",
				"insert into items values (2, 1, 1, 1, 'Editor');",
				`insert into editors values (2, 1, ${sqlQuote(secondPath)}, ${sqlQuote(secondContents)});`,
				`insert into editor_selections values (2, 1, ${start}, ${end});`,
				"update panes set active = 0 where pane_id = 1;",
				"commit;",
			].join("\n"),
		});

		await waitFor(
			() => stripAnsi(tui.render()[0] ?? "").endsWith(" second.ts:3"),
			ZED_CONTEXT_POLL_INTERVAL_MS * 4,
		);
		assert.deepEqual(tui.statuses, []);
		assert.ok(tui.renderRequests >= 2);

		const beforeAgentStart = handlers.get("before_agent_start");
		assert.ok(beforeAgentStart);
		const result = await beforeAgentStart({}, tui.ctx) as { message?: { content: string } };
		assert.match(result.message?.content ?? "", new RegExp(`File: ${secondPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(result.message?.content ?? "", /Selection 1: 3:1-3:6/);
		assert.match(result.message?.content ?? "", /gamma/);
	} finally {
		if (started) await handlers.get("session_shutdown")?.({}, tui.ctx);
		if (previous === undefined) delete process.env.PI_ZED_DB;
		else process.env.PI_ZED_DB = previous;
		rmSync(value.dir, { recursive: true, force: true });
	}
});

test("formats compact footer context and keeps it on the workspace line", () => {
	const context = {
		filePath: "/tmp/src/file.ts",
		ranges: [{
			text: "selected",
			selection: { start: { line: 12, character: 1 }, end: { line: 15, character: 2 } },
		}],
	};
	assert.equal(formatFooterContext(context), "file.ts:12-15");

	const theme = {
		fg(_color: "dim", text: string) { return text; },
		italic(text: string) { return `\x1b[3m${text}\x1b[23m`; },
	};
	const lines = addContextToFooter(["~/project (main)", "stats"], "file.ts:12-15", 80, theme);
	assert.equal(stripAnsi(lines[0] ?? ""), "~/project (main) file.ts:12-15");
	assert.equal(lines.length, 2);
	assert.match(lines[0] ?? "", /\x1b\[3mfile\.ts:12-15\x1b\[23m/);
});

test("deactivates outside Zed and filters context persisted by an earlier Zed run", async () => {
	const handlers = new Map<string, Function>();
	let tools = 0;
	let commands = 0;
	const pi = {
		registerTool() { tools += 1; },
		registerCommand() { commands += 1; },
		on(name: string, handler: Function) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	mikotoZed(pi, { terminal: null });

	assert.equal(tools, 0);
	assert.equal(commands, 0);
	assert.deepEqual([...handlers.keys()], ["context"]);

	const context = handlers.get("context");
	assert.ok(context);
	const keep = { role: "user", content: [{ type: "text", text: "hello" }] };
	const stale = { role: "custom", customType: "zed-context", content: "stale" };
	const other = { role: "custom", customType: "other-extension", content: "keep" };
	const result = await context({ messages: [keep, stale, other] }, {});
	assert.deepEqual(result.messages, [keep, other]);
});

test("stops injecting and filters old context after the Zed parent exits", async () => {
	const value = fixture({});
	const handlers = new Map<string, Function[]>();
	let active = true;
	const terminal = { isActive: () => active };
	const pi = {
		registerTool() {},
		registerCommand() {},
		on(name: string, handler: Function) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	mikotoZed(pi, { terminal });

	const previous = process.env.PI_ZED_DB;
	process.env.PI_ZED_DB = value.dbPath;
	const tui = tuiContext(value.dir);
	let started = false;
	try {
		const sessionStart = handlers.get("session_start")?.[0];
		assert.ok(sessionStart);
		await sessionStart({}, tui.ctx);
		started = true;
		assert.match(stripAnsi(tui.render()[0] ?? ""), / file\.ts:2$/);

		const beforeAgentStart = handlers.get("before_agent_start")?.[0];
		assert.ok(beforeAgentStart);
		assert.ok((await beforeAgentStart({}, tui.ctx))?.message);

		active = false;
		assert.equal(await beforeAgentStart({}, tui.ctx), undefined);
		assert.deepEqual(tui.render(), []);

		const context = handlers.get("context")?.[0];
		assert.ok(context);
		const stale = { role: "custom", customType: "zed-context", content: "stale" };
		const keep = { role: "user", content: [{ type: "text", text: "hello" }] };
		const filtered = await context({ messages: [stale, keep] }, tui.ctx);
		assert.deepEqual(filtered.messages, [keep]);
	} finally {
		if (started) await handlers.get("session_shutdown")?.[0]?.({}, tui.ctx);
		if (previous === undefined) delete process.env.PI_ZED_DB;
		else process.env.PI_ZED_DB = previous;
		rmSync(value.dir, { recursive: true, force: true });
	}
});

test("detects Zed terminal markers and a Zed process ancestor", () => {
	assert.equal(isZedTerminalEnvironment({ TERM_PROGRAM: "zed" }), true);
	assert.equal(isZedTerminalEnvironment({ ZED_TERM: "true" }), true);
	assert.equal(isZedTerminalEnvironment({ TERM_PROGRAM: "iTerm.app" }), false);

	assert.equal(findZedAncestorPid([
		{ pid: 10, parentPid: 20, command: "fish" },
		{ pid: 20, parentPid: 30, command: "/Applications/Zed Preview.app/Contents/MacOS/zed" },
		{ pid: 30, parentPid: 1, command: "/sbin/launchd" },
	], 10), 20);
	assert.equal(findZedAncestorPid([
		{ pid: 10, parentPid: 20, command: "fish" },
		{ pid: 20, parentPid: 1, command: "/Applications/iTerm.app/Contents/MacOS/iTerm2" },
	], 10), undefined);
});

test("caps formatted context below Pi's 50 KiB tool-output limit", () => {
	const previous = process.env.PI_ZED_MAX_CONTEXT_BYTES;
	process.env.PI_ZED_MAX_CONTEXT_BYTES = "99999999";
	try {
		const output = formatContext({
			filePath: "/tmp/large.ts",
			ranges: [{
				text: "😀".repeat(100_000),
				selection: { start: { line: 1, character: 1 }, end: { line: 1, character: 100_001 } },
			}],
		});
		assert.ok(Buffer.byteLength(output, "utf8") <= 50 * 1024);
		assert.match(output, /truncated/);
		assert.ok(output.endsWith("</zed-context>"));
	} finally {
		if (previous === undefined) delete process.env.PI_ZED_MAX_CONTEXT_BYTES;
		else process.env.PI_ZED_MAX_CONTEXT_BYTES = previous;
	}
});

test("converts UTF-8 byte offsets and positions", () => {
	const text = "😀\nЖx";
	assert.equal(utf8ByteOffsetToStringIndex(text, byteOffset(text, text.indexOf("Ж"))), text.indexOf("Ж"));
	assert.deepEqual(offsetsToSelection(text, text.indexOf("Ж"), text.length), {
		start: { line: 2, character: 1 },
		end: { line: 2, character: 3 },
	});
});
