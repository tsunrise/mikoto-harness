import assert from "node:assert/strict";
import { test } from "node:test";
import type * as vscode from "vscode";
import { startIntegration } from "../src/lifecycle";
import { SOCKET_VARIABLE } from "../src/protocol";
import { fakeAPI } from "./helpers";

function environment() {
  const values = new Map<string, string>([["OTHER", "preserved"]]);
  const collection = {
    persistent: true,
    delete: (name: string) => values.delete(name),
    replace: (name: string, value: string) => { values.set(name, value); },
  };
  return {
    values, collection,
    context: { environmentVariableCollection: collection as unknown as vscode.EnvironmentVariableCollection },
  };
}

test("exports only after listen, clears only its own mutator, and disposes subscriptions", async () => {
  const fake = fakeAPI();
  const env = environment();
  let disposed = 0;
  const integration = await startIntegration(fake.typed, env.context, {
    platform: "linux",
    startServer: async () => {
      assert.equal(env.values.has(SOCKET_VARIABLE), false);
      return { socketPath: "/tmp/test.sock", dispose: async () => { disposed++; } };
    },
  });
  assert.equal(env.collection.persistent, false);
  assert.equal(env.values.get(SOCKET_VARIABLE), "/tmp/test.sock");
  await integration.dispose();
  await integration.dispose();
  assert.equal(env.values.has(SOCKET_VARIABLE), false);
  assert.equal(env.values.get("OTHER"), "preserved");
  assert.equal(disposed, 1);
  assert.equal(fake.listeners(), 0);
});

test("Windows, remote and untrusted hosts never start a server", async () => {
  for (const kind of ["windows", "remote", "untrusted"]) {
    const fake = fakeAPI();
    if (kind === "remote") fake.api.env.remoteName = "ssh-remote";
    if (kind === "untrusted") fake.api.workspace.isTrusted = false;
    const integration = await startIntegration(fake.typed, environment().context, {
      platform: kind === "windows" ? "win32" : "darwin",
      startServer: async () => { throw new Error("must not start"); },
      warn: () => assert.fail("unexpected startup"),
    });
    assert.equal(fake.listeners(), 0);
    await integration.dispose();
  }
});

test("startup failure and later listener failure clear endpoint and subscriptions", async () => {
  for (const early of [true, false]) {
    const fake = fakeAPI();
    const env = environment();
    let failure: (() => void) | undefined;
    let disposed = 0;
    const integration = await startIntegration(fake.typed, env.context, {
      platform: "linux", warn: () => {},
      startServer: async (_capture, options) => {
        failure = options?.onFailure;
        if (early) throw new Error("listen failed");
        return { socketPath: "/tmp/test.sock", dispose: async () => { disposed++; } };
      },
    });
    if (!early) failure!();
    await integration.dispose();
    assert.equal(env.values.has(SOCKET_VARIABLE), false);
    assert.equal(fake.listeners(), 0);
    assert.equal(disposed, early ? 0 : 1);
  }
});
