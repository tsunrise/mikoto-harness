// This is a release gate, not the Garden executor. In particular the direct
// host launch below is a fixture, not an escalation implementation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const account = userInfo();
const baseEnv = {
  HOME: account.homedir,
  USER: account.username,
  LOGNAME: account.username,
  PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
};

async function run(argv, env, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      env, stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    }, timeout);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output = (output + chunk.toString("utf8")).slice(-8192);
      });
    }
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut });
    });
  });
}

// SRT resolves upstream proxies from its own environment. Start a clean
// fixture process, rather than merely filtering the workload's environment.
if (process.argv[2] !== "--clean-parent") {
  const result = await run(
    [process.execPath, fileURLToPath(import.meta.url), "--clean-parent"],
    baseEnv,
    120_000,
  );
  process.stdout.write(result.output);
  process.exitCode = result.code ?? 1;
} else {
  assert.equal(process.platform, "darwin", "Gate 1 requires real macOS");
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  const servers = [];
  const files = [];
  const directories = [];
  async function endpoint() {
    const token = randomBytes(32).toString("hex");
    const expected = Buffer.from(`Bearer ${token}`);
    const server = createServer((req, res) => {
      const actual = Buffer.from(req.headers.authorization ?? "");
      const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
      res.writeHead(ok ? 200 : 401, { "content-type": "text/plain" });
      res.end(ok ? "garden-ok" : "unauthorized");
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return { port: server.address().port, token };
  }
  try {
    console.log(`Platform: ${process.platform}/${process.arch}; Node: ${process.version}; SRT: 0.0.75`);
    const a = await endpoint();
    const b = await endpoint();
    let liveEndpoint = a;
    let throwDecision = false;
    const decisions = [];
    const config = {
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      network: {
        allowedDomains: [], deniedDomains: [], strictAllowlist: false,
        allowAllUnixSockets: false, allowLocalBinding: false,
      },
    };
    await SandboxManager.initialize(config, async ({ host, port }) => {
      decisions.push({ host, port });
      if (throwDecision) throw new Error("fixture callback failure");
      // Equivalent to deny-all plus the sole exact infrastructure exception.
      return host === "127.0.0.1" && port === liveEndpoint?.port;
    }, false);
    const env = {
      ...baseEnv,
      GARDEN_SERVER: `http://127.0.0.1:${a.port}`,
      GARDEN_TOKEN: a.token,
    };
    async function sandbox(cmd, correctBypass = true) {
      const payload = `${correctBypass ? "export NO_PROXY='' no_proxy=''; " : ""}exec /bin/sh -c ${quote(cmd)}`;
      const wrapped = await SandboxManager.wrapWithSandboxArgv(payload, "/bin/sh");
      try {
        assert.match(wrapped.argv.join(" "), /sandbox-exec/, "No OS wrapper acquired");
        return await run(wrapped.argv, env);
      } finally {
        SandboxManager.cleanupAfterCommand();
      }
    }
    async function pass(label, command) {
      const before = decisions.length;
      const result = await sandbox(command);
      assert.equal(result.code, 0, `${label}: ${result.output}`);
      assert.equal(result.output, "garden-ok", `${label}: response`);
      assert.ok(decisions.length > before, `${label}: did not reach destination evaluator`);
      console.log(`PASS ${label}`);
    }
    const curl = '/usr/bin/curl --silent --show-error --fail --max-time 3 "$GARDEN_SERVER/probe" -H "Authorization: Bearer $GARDEN_TOKEN" -d Hello';
    await pass("curl via HTTP proxy", curl);
    const python = "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3";
    await pass("Python urllib via HTTP proxy", `${quote(python)} -c ${quote(
      'import os, urllib.request; r=urllib.request.Request(os.environ["GARDEN_SERVER"]+"/probe", data=b"Hello", headers={"Authorization": "Bearer "+os.environ["GARDEN_TOKEN"]}); print(urllib.request.urlopen(r, timeout=3).read().decode(), end="")',
    )}`);
    await pass("Node native HTTP with --use-env-proxy", `${quote(process.execPath)} --use-env-proxy -e ${quote(
      'require("node:http").get(process.env.GARDEN_SERVER+"/probe",{headers:{Authorization:"Bearer "+process.env.GARDEN_TOKEN}},r=>{r.pipe(process.stdout);if(r.statusCode!==200)process.exitCode=1}).on("error",()=>process.exitCode=1)',
    )}`);
    await pass("Node fetch with --use-env-proxy", `${quote(process.execPath)} --use-env-proxy -e ${quote(
      'fetch(process.env.GARDEN_SERVER+"/probe",{headers:{Authorization:"Bearer "+process.env.GARDEN_TOKEN}}).then(async r=>{process.stdout.write(await r.text());if(r.status!==200)process.exitCode=1}).catch(()=>process.exitCode=1)',
    )}`);
    await pass("HTTP CONNECT via proxy", curl.replace("--silent", "--proxytunnel --silent"));
    await pass("SOCKS via proxy", `${quote(process.execPath)} -e ${quote(
      'const u=new URL(process.env.HTTP_PROXY);const r=require("node:child_process").spawnSync("/usr/bin/curl",["--silent","--show-error","--fail","--max-time","3","--proxy","socks5h://"+u.hostname+":"+u.port,"--proxy-user",decodeURIComponent(u.username)+":"+decodeURIComponent(u.password),process.env.GARDEN_SERVER+"/probe","-H","Authorization: Bearer "+process.env.GARDEN_TOKEN],{encoding:"utf8"});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.status??1',
    )}`);
    assert.notEqual((await sandbox(curl, false)).code, 0, "Uncorrected loopback bypass unexpectedly connected");
    console.log("PASS direct loopback blocked without inner bypass correction");
    assert.notEqual((await sandbox(curl.replace("$GARDEN_SERVER", `http://127.0.0.1:${b.port}`))).code, 0);
    console.log("PASS other session endpoint denied");
    const host = await run(["/bin/sh", "-c", curl], env);
    assert.equal(host.code, 0);
    assert.equal(host.output, "garden-ok");
    console.log("PASS direct host client with capability environment");
    const crossToken = await run(["/bin/sh", "-c", curl], {
      ...env, GARDEN_SERVER: `http://127.0.0.1:${b.port}`,
    });
    assert.notEqual(crossToken.code, 0);
    console.log("PASS session A token rejected by server B");
    liveEndpoint = undefined;
    assert.notEqual((await sandbox(curl)).code, 0);
    console.log("PASS live endpoint revocation");
    throwDecision = true;
    assert.notEqual((await sandbox(curl)).code, 0);
    console.log("PASS callback exception denies");
    // All write probes target freshly created fixture files in this package.
    // We do not probe real user configuration/log files by modifying them.
    const root = await realpath(await mkdtemp(fileURLToPath(new URL("../gate-run-", import.meta.url))));
    directories.push(root);
    for (const relative of ["scratch", "private", "read-denied", "read-denied/allowed", "read-denied/allowed/denied", "read-denied/allowed/denied/reallowed"]) {
      const dir = join(root, relative);
      await mkdir(dir);
      directories.push(dir);
    }
    for (const relative of ["private/log", "read-denied/secret", "read-denied/allowed/public", "read-denied/allowed/denied/secret", "read-denied/allowed/denied/reallowed/public"]) {
      const file = join(root, relative);
      await writeFile(file, "fixture", { flag: "wx", mode: 0o600 });
      files.push(file);
    }
    config.filesystem = {
      denyRead: [join(root, "private"), join(root, "read-denied"), join(root, "read-denied/allowed/denied")],
      allowRead: [join(root, "read-denied/allowed"), join(root, "read-denied/allowed/denied/reallowed")],
      allowWrite: [join(root, "scratch")],
      denyWrite: [join(root, "private"), "/private/tmp/claude", join(account.homedir, ".npm/_logs"), join(account.homedir, ".claude/debug")],
    };
    SandboxManager.updateConfig(config);
    for (const relative of ["private/log", "read-denied/secret", "read-denied/allowed/denied/secret"]) {
      assert.notEqual((await sandbox(`/bin/cat ${quote(join(root, relative))}`)).code, 0, `${relative} must be unreadable`);
    }
    console.log("PASS private log and nested read denials");
    assert.equal((await sandbox(`/bin/cat ${quote(join(root, "read-denied/allowed/public"))}`)).code, 0);
    console.log("PASS read allow inside deny");
    const scratchFile = join(root, "scratch/created");
    files.push(scratchFile);
    assert.equal((await sandbox(`printf scratch > ${quote(scratchFile)}`)).code, 0);
    assert.notEqual((await sandbox(`printf bad >> ${quote(join(root, "private/log"))}`)).code, 0);
    console.log("PASS scratch write and private log write isolation");
    const nested = await sandbox(`/bin/cat ${quote(join(root, "read-denied/allowed/denied/reallowed/public"))}`);
    assert.notEqual(nested.code, 0, "Update the compiler baseline if upstream literal semantics change");
    console.log("CONFIRMED copying literal arrays loses alternating read specificity");
    // Probe whether SRT's documented glob carve-outs can represent the same
    // literal regions. A singleton character class matches exactly one fixed
    // character; it is not a wildcard grant. The compiled-executor filesystem
    // fixture separately checks the production compiler's use of this branch.
    config.filesystem.denyRead = config.filesystem.denyRead.map((target) =>
      target.replace(/([a-z])([^/]*)$/, "[$1]$2"));
    SandboxManager.updateConfig(config);
    assert.equal((await sandbox(`/bin/cat ${quote(join(root, "read-denied/allowed/denied/reallowed/public"))}`)).code, 0,
      "Exact-region glob translation failed nested re-allow");
    for (const relative of ["private/log", "read-denied/secret", "read-denied/allowed/denied/secret"]) {
      assert.notEqual((await sandbox(`/bin/cat ${quote(join(root, relative))}`)).code, 0, `${relative} was widened`);
    }
    console.log("PASS experimental exact-region translation preserves nested read access");
    const alias = join(root, "READ-DENIED/ALLOWED/DENIED/secret");
    assert.notEqual((await sandbox(`/bin/cat ${quote(alias)}`)).code, 0, "Case alias bypasses read denial");
    console.log("PASS case alias denied");
    await SandboxManager.reset();
    await SandboxManager.initialize(config, undefined, false);
    assert.notEqual((await sandbox(curl)).code, 0);
    console.log("PASS missing callback denies");
    console.log("Gate 1 subset passed; remaining acceptance checks still required.");
  } finally {
    await SandboxManager.reset();
    await Promise.all(servers.map((server) => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    })));
    // Delete only the explicit files we created, then empty directories. An
    // unexpected artifact causes cleanup failure instead of recursive removal.
    for (const file of files.reverse()) await unlink(file).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    for (const dir of directories.reverse()) await rmdir(dir);
  }
}
