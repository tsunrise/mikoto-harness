# Mikoto VS Code Context

A local VS Code companion for `extensions/mikoto-vscode-context`, serving
on-demand editor snapshots through a per-window private Unix socket.

## Build and install

From `mikoto-harness/vscode/mikoto` (this is **not** a root npm workspace):

```sh
npm install
npm run validate
npm run package
npm run test:vsix
code --install-extension mikoto-vscode-context-0.1.0.vsix
```

Install/load the Pi package following its README. Open a **new integrated
terminal after activation**, then launch Pi. Existing terminal processes
cannot acquire later environment changes. Each VS Code window exports its
own `MIKOTO_VSCODE_CONTEXT_SOCKET`; after reloading/restarting VS Code, use a
new terminal and Pi process rather than a stale inherited path.

Use `/vscode preview` and `/vscode toggle` in Pi. Nothing is sent to a
provider by this VSIX itself.
