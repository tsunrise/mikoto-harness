import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { readOnlyProbeCredentials } from "../scripts/probe-credentials.ts";

it("live probes can only read the selected OAuth credential and cannot refresh, lock or mutate it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "probe-auth-test-"));
  try {
    const path = join(directory, "auth.json");
    const credential = { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: 100 };
    const contents = JSON.stringify({ selected: credential, unrelated: credential });
    await writeFile(path, contents);
    const store = readOnlyProbeCredentials("selected", path);
    assert.deepEqual(await store.read("selected"), credential);
    assert.equal(await store.read("unrelated"), undefined);
    assert.deepEqual(await store.list(), [{ providerId: "selected", type: "oauth" }]);
    let refreshed = false;
    await assert.rejects(store.modify("selected", async () => {
      refreshed = true;
      return { ...credential, type: "oauth" };
    }));
    await assert.rejects(store.delete("selected"));
    await assert.rejects(store.read("selected", { signal: AbortSignal.abort() }));
    assert.equal(refreshed, false);
    assert.equal(await readFile(path, "utf8"), contents);
    assert.deepEqual(await readdir(directory), ["auth.json"]);
    await writeFile(path, '{"selected":{"type":"oauth","access":false}}');
    assert.equal(await store.read("selected"), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
