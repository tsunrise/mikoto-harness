import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rmdir } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { ContextError, endpointFromEnvironment, request } from "../src/client.ts";

async function server(t: TestContext, reply: (socket: net.Socket) => void) {
  const directory = await mkdtemp("/tmp/mikoto-client-");
  const endpoint = directory + "/s";
  const clients = new Set<net.Socket>();
  const listener = net.createServer(socket => {
    clients.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
    socket.once("data", () => reply(socket));
  });
  await new Promise<void>(resolve => listener.listen(endpoint, resolve));
  t.after(async () => {
    for (const socket of clients) socket.destroy();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await rmdir(directory);
  });
  return endpoint;
}

test("endpoint defaults reject missing/relative/oversized/Windows values", () => {
  for (const path of [undefined, "relative", "/nul\0", "/" + "x".repeat(100)]) {
    assert.equal(endpointFromEnvironment({ MIKOTO_VSCODE_CONTEXT_SOCKET: path }, "linux"), undefined);
  }
  assert.equal(endpointFromEnvironment({ MIKOTO_VSCODE_CONTEXT_SOCKET: "/tmp/s" }, "win32"), undefined);
  assert.equal(endpointFromEnvironment({ MIKOTO_VSCODE_CONTEXT_SOCKET: "/tmp/s" }, "darwin"), "/tmp/s");
});

test("handshake handles split bytes, stale sockets, timeout, and cancellation", async t => {
  const endpoint = await server(t, socket => {
    socket.write('{"version":1,');
    socket.end('"status":"ok"}\n');
  });
  assert.equal((await request(endpoint, "ping")).status, "ok");
  await assert.rejects(request(endpoint + "-missing", "ping"), (e: ContextError) => e.kind === "unavailable");
  const hanging = await server(t, () => {});
  await assert.rejects(request(hanging, "ping", undefined, 20), (e: ContextError) => e.kind === "unavailable");
  const controller = new AbortController();
  const pending = request(hanging, "ping", controller.signal);
  controller.abort();
  await assert.rejects(pending, (e: ContextError) => e.kind === "aborted");
});

test("malformed/oversized/early EOF/wrong-command responses never pass validation", async t => {
  for (const data of [
    "bad\n", '{"version":2,"status":"ok"}\n', '{"version":1,"status":"empty"}\n',
    "x".repeat(65537), '{"version":1,"status":"ok"}', Buffer.from([0xff, 10]),
  ]) {
    const endpoint = await server(t, socket => socket.end(data));
    await assert.rejects(request(endpoint, "ping"), (e: ContextError) => e.kind === "malformed");
  }
});
