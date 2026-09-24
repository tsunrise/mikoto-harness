import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, isAbsolute } from "node:path";

const cwd = process.argv[2];
assert.ok(cwd && isAbsolute(cwd), "Pass the production-only install directory");
const env = {
  HOME: userInfo().homedir, USER: userInfo().username,
  PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
};
const child = fork(join(cwd, "node_modules/mikoto-garden/dist/executor/main.js"), [], {
  execPath: process.execPath, execArgv: [], env, stdio: ["ignore", "ignore", "ignore", "ipc"],
});
let id = 0;
async function request(method, data) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Packed ${method} timed out`)), 15000);
    const receive = (message) => {
      if (message.id !== requestId || message.event) return;
      clearTimeout(timer);
      child.removeListener("message", receive);
      message.error ? reject(new Error(message.error)) : resolve(message.result);
    };
    child.on("message", receive);
    child.send({ generation: "packed-fixture", id: requestId, method, data });
  });
}
const identity = async (path) => {
  const info = await stat(path);
  return `${info.dev}:${info.ino}`;
};
try {
  await request("init", {
    contract: "garden-pipes-2", runtimeParent: cwd,
    policy: {
      filesystem: { denyRead: [], allowRead: [], allowWrite: [cwd], denyWrite: [] },
      network: { allowedDomains: [], deniedDomains: ["*"], allowLocalBinding: false, allowUnixSockets: [] },
    },
  });
  const shell = await realpath("/bin/sh");
  const result = await request("spawn", {
    launch: {
      cmd: "printf packed-ok", cwd, shell, login: false, stdin: false,
      mode: "sandboxed", env, cwdIdentity: await identity(cwd), shellIdentity: await identity(shell), capabilities: false,
    },
    wait: 1000, tokens: 1000,
  });
  assert.equal(result.job.exit_code, 0);
  assert.equal(result.output, "packed-ok");
  await request("ack", { id: result.job.id, chunk: result.chunk });
  assert.deepEqual((await request("shutdown", {})).warnings, []);
  console.log("PASS production-only packed JavaScript executor: sandboxed spawn, output, cleanup");
} finally { if (child.connected) child.disconnect(); }
