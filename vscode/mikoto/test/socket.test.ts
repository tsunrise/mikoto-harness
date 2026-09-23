import assert from "node:assert/strict";
import net from "node:net";
import { stat, access, mkdtemp, rmdir } from "node:fs/promises";
import { test } from "node:test";
import { createContextServer } from "../src/socket";
import { createCapture } from "../src/capture";
import { fakeAPI } from "./helpers";

// Load the independently installable Pi client through tsx, without pulling its
// files into this package's production compilation or VSIX.
const clientModule = "../../../extensions/mikoto-vscode-context/src/client.ts";
const client = import(clientModule);

function exchange(path: string, chunks: Buffer[], end = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let result = "";
    socket.on("error", reject);
    socket.on("data", data => { result += data.toString(); });
    socket.on("close", () => resolve(result));
    socket.on("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
      if (end) socket.end();
    });
  });
}

test("real server and Pi client interoperate; permissions and owned cleanup", async () => {
  const fake = fakeAPI();
  const capture = createCapture(fake.typed);
  const server = await createContextServer(capture.capture);
  try {
    const { request } = await client;
    assert.equal((await stat(server.socketPath)).mode & 0o777, 0o600);
    const directory = server.socketPath.slice(0, server.socketPath.lastIndexOf("/"));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await request(server.socketPath, "ping")).status, "ok");
    const response = await request(server.socketPath, "getContext");
    assert.equal(response.context.selections[0].text, "unsaved text");
    fake.change(undefined);
    assert.equal((await request(server.socketPath, "getContext")).status, "context");
    fake.hide();
    assert.equal((await request(server.socketPath, "getContext")).status, "empty");
  } finally {
    capture.dispose();
    await server.dispose();
    await server.dispose();
  }
  await assert.rejects(access(server.socketPath));
});

test("bounded framing rejects malformed requests and dispatches just one line", async () => {
  let captures = 0;
  const server = await createContextServer(() => { captures++; return undefined; });
  try {
    for (const data of ['{"version":2,"command":"ping"}\n', '{}\n', "invalid\n", "x".repeat(1025)]) {
      const result = await exchange(server.socketPath, [Buffer.from(data)]);
      assert.equal(JSON.parse(result).status, "error");
    }
    assert.equal(JSON.parse(await exchange(server.socketPath, [Buffer.from([0xff, 10])])).status, "error");
    assert.equal(await exchange(server.socketPath, [Buffer.from("{")], true), "");
    const line = Buffer.from('{"version":1,"command":"getContext","extra":"😀"}\n');
    const split = line.indexOf(Buffer.from("😀")) + 1;
    const result = await exchange(server.socketPath, [
      line.subarray(0, split), line.subarray(split), Buffer.from('{"version":1,"command":"getContext"}\n'),
    ]);
    assert.equal(JSON.parse(result).status, "empty");
    assert.equal(captures, 1);
  } finally { await server.dispose(); }
});

test("idle clients hit an absolute deadline; connection capacity and disposal are bounded", async () => {
  const server = await createContextServer(() => undefined, { deadlineMs: 150 });
  const sockets: net.Socket[] = [];
  try {
    for (let i = 0; i < 16; i++) {
      const socket = net.createConnection(server.socketPath);
      sockets.push(socket);
      socket.on("error", () => {});
      await new Promise<void>(resolve => socket.once("connect", resolve));
    }
    const extra = net.createConnection(server.socketPath);
    extra.on("error", () => {});
    await new Promise<void>(resolve => extra.once("close", resolve));
    assert.ok(sockets.some(socket => !socket.destroyed));
    const slow = sockets[0];
    const trickle = setInterval(() => { if (!slow.destroyed) slow.write(" "); }, 10);
    await new Promise<void>(resolve => slow.once("close", resolve));
    clearInterval(trickle);
    assert.ok(slow.destroyed);
    await server.dispose();
    assert.ok(sockets.every(socket => socket.destroyed || socket.readableEnded));
  } finally {
    sockets.forEach(socket => socket.destroy());
    await server.dispose();
  }
});

test("overlong temporary roots fall back and leave no unused private directory", async () => {
  const root = await mkdtemp("/tmp/" + "mikoto-long-".repeat(8));
  const server = await createContextServer(() => undefined, { temporaryRoot: root });
  try {
    assert.ok(Buffer.byteLength(server.socketPath) <= 100);
    assert.ok(!server.socketPath.startsWith(root + "/"));
    await rmdir(root); // This only succeeds if the abandoned private directory was removed.
  } finally { await server.dispose(); }
});
