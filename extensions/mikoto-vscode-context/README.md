# Mikoto VS Code Context for Pi

Adds on-demand editor snapshots from the companion **Mikoto VS Code Context**
VSIX. Supports local macOS/Linux VS Code and Pi; not Windows, Remote/SSH,
containers, web VS Code, or discovery of Pi processes outside integrated
terminals. No polling, status UI, model-callable tool, or dependency on Zed.

## Setup

From the `mikoto-harness` repository root:

```sh
npm install
pi install /absolute/path/to/mikoto-harness/extensions/mikoto-vscode-context
# Or load only for this invocation:
pi -e ./extensions/mikoto-vscode-context
```

Build and install the companion VSIX using `vscode/mikoto/README.md`.
After it activates in a trusted workspace, open a **new integrated terminal**
and launch Pi there. Existing terminal processes do not inherit later
environment updates. After restarting/reloading VS Code, start a new terminal
and Pi process to pick up the new socket path.

## Commands and behavior

- `/vscode preview`: while enabled, fetch and show exactly the formatted
  context eligible for the next prompt. This does not add a session entry.
- `/vscode toggle`: disable new captures, or enable after a successful live
  handshake. This choice lasts for the Pi extension instance across session
  switches; it is not stored on disk.

On the first session start, context defaults **on only when a live version-1
server responds** at `MIKOTO_VSCODE_CONTEXT_SOCKET`. 

Capture happens when Pi dispatches `before_agent_start`, not when a queued
prompt was originally typed. Each capture includes the file, containing
workspace folder, cursor/selection positions and selected buffer text,
including unsaved edits. It does not read whole unselected files or disk
contents. 

## Development and removal

```sh
# From mikoto-harness:
npm run validate -w mikoto-vscode-context
npm run validate
```

The VS Code package is independent and needs its own validation.
Tests exercise transport, schema/size validation, scoping, escaping, lifecycle,
and session-to-model conversion without provider calls.

