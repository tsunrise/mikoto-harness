import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFile } from "node:fs/promises";
import { fingerprint, loadConfig, normalizeConfig } from "../src/config.ts";
import { boundedArguments, callSchema, encodeJson, MiB } from "../src/schema.ts";
import { directory } from "./helpers.ts";

test("normalizes transports, static credentials, cwd, commands, and minimal child environment", () => {
  const { entries } = normalizeConfig({ ignored: true, mcpServers: {
    local: { command: "./bin/server", args: ["${ARG}"], cwd: "../project", env: { KEY: "${TOKEN}", GARDEN_TOKEN: "never", GARDEN_SERVER: "never" } },
    path: { command: "node" },
    home: { command: "~/bin/server", cwd: "~/project" },
    remote: { type: "streamable-http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
    legacy: { type: "sse", url: "http://127.0.0.1/sse" },
  } }, "/config/mcp.json", "/cwd", { ARG: "x", TOKEN: "secret" }, { PATH: "/bin" });
  const local = entries[0].config;
  assert.deepEqual(local, { type: "stdio", command: "/project/bin/server", args: ["x"], cwd: "/project", env: { PATH: "/bin", KEY: "secret" } });
  assert.equal(entries[1].config?.type, "stdio");
  assert.equal((entries[1].config as { cwd: string }).cwd, "/cwd");
  assert.equal((entries[2].config as { command: string }).command, join(homedir(), "bin/server"));
  assert.deepEqual(entries[3].config, { type: "http", url: "https://example.com/mcp", headers: { authorization: "Bearer secret" } });
  assert.equal(entries[4].config?.type, "sse");
  assert.ok(!entries[0].fingerprint?.includes("secret"));
});

test("isolates bad entries and excludes disabled/OAuth without env expansion", () => {
  const entries = normalizeConfig({ mcpServers: {
    good: { url: "http://localhost/mcp" },
    disabled: { disabled: true, command: "${MISSING}" },
    oauth: { oauth: {}, url: "${MISSING}" },
    auth: { auth: "apiKey", command: "${MISSING}" },
    missing: { command: "${MISSING}" },
    mixed: { command: "node", url: "https://example.com" },
    unknown: { command: "node", shell: true },
    mismatch: { type: "sse", command: "node" },
    remoteEnv: { url: "https://example.com", env: {} },
    userinfo: { url: "https://u:p@example.com" },
    fragment: { url: "https://example.com/#x" },
    "bad\nname": { command: "node" },
  } }, "/config/mcp.json", "/cwd", {}, {}).entries;
  assert.equal(entries.filter(e => e.config).length, 1);
  assert.equal(entries[1].reason, "configured_disabled");
  assert.equal(entries[2].reason, "unsupported_auth");
  assert.equal(entries[3].reason, "unsupported_auth");
  assert.ok(entries.slice(4).every(e => e.reason === "invalid_config"));
});

test("rejects forbidden/invalid headers, unsupported expansion, and config bounds", () => {
  for (const headers of [{ Host: "x" }, { "Content-Type": "x" }, { "mcp-session-id": "x" }, { "bad key": "x" }, { x: "\r\nsecret" }]) {
    assert.equal(normalizeConfig({ mcpServers: { s: { url: "https://example.com", headers } } }, "/c", "/c").entries[0].reason, "invalid_config");
  }
  for (const entry of [
    { command: "${TOKEN:-fallback}" }, { command: "x", args: Array(257).fill("") },
    { command: "x".repeat(16385) }, { command: "x", env: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`e${i}`, ""])) },
  ]) assert.equal(normalizeConfig({ mcpServers: { s: entry } }, "/c", "/c").entries[0].reason, "invalid_config");
  assert.throws(() => normalizeConfig({ mcpServers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [i, { command: "x" }])) }, "/c", "/c"));
});

test("disabledTools is parsed without affecting the fingerprint", () => {
  const [plain, hidden, bad] = normalizeConfig({ mcpServers: {
    plain: { url: "https://example.com/mcp" },
    hidden: { url: "https://example.com/mcp", disabledTools: ["a", "b"] },
    bad: { url: "https://example.com/mcp", disabledTools: [""] },
  } }, "/c", "/c").entries;
  assert.equal(plain.disabledTools, undefined);
  assert.deepEqual([...hidden.disabledTools!], ["a", "b"]);
  assert.equal(hidden.fingerprint, plain.fingerprint);
  assert.equal(bad.reason, "invalid_config");
});

test("stable fingerprints include credentials, cwd and inherited environment", () => {
  const a = { type: "stdio" as const, command: "node", cwd: "/a", args: [], env: { A: "1", B: "2" } };
  assert.equal(fingerprint(a), fingerprint({ ...a, env: { B: "2", A: "1" } }));
  for (const config of [{ ...a, cwd: "/b" }, { ...a, env: { A: "secret" } }, { ...a, command: "other" }])
    assert.notEqual(fingerprint(a), fingerprint(config));
});

test("missing config is empty; malformed/unreadable/oversized config is unavailable", async t => {
  const root = await directory(t), path = join(root, "mcp.json");
  assert.deepEqual(await loadConfig(path, root), { entries: [], unavailable: false });
  await writeFile(path, "{");
  assert.equal((await loadConfig(path, root)).unavailable, true);
  await writeFile(path, Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]));
  assert.equal((await loadConfig(path, root)).unavailable, true);
  await writeFile(path, " ".repeat(MiB + 1));
  assert.equal((await loadConfig(path, root)).unavailable, true);
  assert.equal((await loadConfig(root, root)).unavailable, true);
});

test("JSON arguments reject non-JSON, excess depth/count and unknown request fields", () => {
  assert.ok(callSchema.safeParse({ server: "s", name: "n" }).success);
  for (const arguments_ of [[], null, { x: Infinity }, { x: undefined }, { x: new Date() }, { x: () => {} }, { a: Array(4096).fill(1) }])
    assert.equal(boundedArguments(arguments_), false);
  let deep: object = {};
  for (let i = 0; i < 33; i++) deep = { x: deep };
  assert.equal(boundedArguments(deep), false);
  assert.equal(callSchema.safeParse({ server: "s", name: "n", url: "secret" }).success, false);
  const value = { a: [1, true, null, { "é": "💚\n" }], b: {} };
  assert.equal(encodeJson(value, 1000, undefined, true), JSON.stringify(value, null, 2));
  assert.equal(encodeJson(value, 1000), JSON.stringify(value));
  assert.throws(() => encodeJson(value, 5), { code: "result_too_large" });
});
