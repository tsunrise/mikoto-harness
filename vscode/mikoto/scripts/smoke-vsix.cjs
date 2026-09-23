// Exercise the packaged CommonJS entrypoint, not source imports. The VS Code
// API is a fake, but activation, Unix transport, capture and cleanup are real.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const Module = require("node:module");

async function main() {
  const packageRoot = path.resolve(__dirname, "..");
  const manifest = require(path.join(packageRoot, "package.json"));
  const archive = path.join(packageRoot, `${manifest.name}-${manifest.version}.vsix`);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mikoto-vsix-smoke-"));
  let extension;
  const originalLoad = Module._load;
  const values = new Map([["UNRELATED", "preserved"]]);
  const text = "unsaved selection 😀";
  const selectedEditor = {
    document: {
      uri: { scheme: "file", fsPath: path.join(directory, "file.ts") },
      isClosed: false,
      offsetAt: p => p.character,
      positionAt: character => ({ line: 0, character }),
      getText: range => text.slice(range.start.character, range.end.character),
    },
    selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: text.length } }],
  };
  const event = () => ({ dispose() {} });
  const api = {
    env: { remoteName: undefined },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    window: {
      activeTextEditor: selectedEditor, visibleTextEditors: [selectedEditor],
      onDidChangeActiveTextEditor: event, onDidChangeVisibleTextEditors: event,
    },
    workspace: {
      isTrusted: true,
      getWorkspaceFolder: () => ({ uri: { scheme: "file", fsPath: directory } }),
      onDidCloseTextDocument: event,
    },
  };
  try {
    execFileSync("unzip", ["-q", archive, "-d", directory]);
    Module._load = function (name, ...args) {
      return name === "vscode" ? api : originalLoad.call(this, name, ...args);
    };
    const installed = path.join(directory, "extension");
    const packagedManifest = require(path.join(installed, "package.json"));
    extension = require(path.resolve(installed, packagedManifest.main));
    Module._load = originalLoad;
    const collection = {
      persistent: true,
      replace: (key, value) => values.set(key, value),
      delete: key => values.delete(key),
    };
    await extension.activate({ environmentVariableCollection: collection });
    const endpoint = values.get("MIKOTO_VSCODE_CONTEXT_SOCKET");
    assert.ok(endpoint);
    assert.equal(collection.persistent, false);
    api.window.activeTextEditor = undefined;
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection(endpoint);
      let input = "";
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("VSIX smoke timeout")); }, 2000);
      socket.on("error", reject);
      socket.on("close", () => clearTimeout(timer));
      socket.on("connect", () => socket.write('{"version":1,"command":"getContext"}\n'));
      socket.on("data", chunk => {
        input += chunk;
        if (input.includes("\n")) {
          socket.destroy();
          try { resolve(JSON.parse(input.split("\n")[0])); } catch (error) { reject(error); }
        }
      });
    });
    assert.equal(response.status, "context");
    assert.equal(response.context.selections[0].text, text);
    await extension.deactivate();
    assert.equal(values.has("MIKOTO_VSCODE_CONTEXT_SOCKET"), false);
    assert.equal(values.get("UNRELATED"), "preserved");
    await assert.rejects(fs.stat(endpoint));
    console.log("Packaged VSIX activation, capture, terminal fallback and cleanup passed (mock VS Code API).");
  } finally {
    Module._load = originalLoad;
    await extension?.deactivate();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
