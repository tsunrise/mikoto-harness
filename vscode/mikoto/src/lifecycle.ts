import type * as vscode from "vscode";
import { createCapture, type EditorAPI } from "./capture";
import { createContextServer, type ContextServer } from "./socket";
import { SOCKET_VARIABLE } from "./protocol";

type API = EditorAPI & Pick<typeof vscode, "env">;
type Dependencies = {
  platform?: string;
  startServer?: typeof createContextServer;
  warn?: (message: string) => void;
};

export async function startIntegration(
  api: API,
  context: { environmentVariableCollection: Pick<vscode.EnvironmentVariableCollection, "persistent" | "delete" | "replace"> },
  dependencies: Dependencies = {},
): Promise<{ dispose(): Promise<void> }> {
  const collection = context.environmentVariableCollection;
  const warn = dependencies.warn ?? console.warn;
  const platform = dependencies.platform ?? process.platform;
  collection.delete(SOCKET_VARIABLE);
  if (!["darwin", "linux"].includes(platform) || api.env.remoteName !== undefined || !api.workspace.isTrusted) {
    return { dispose: async () => {} };
  }
  const capture = createCapture(api);
  let server: ContextServer | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= (async () => {
    disposed = true;
    collection.delete(SOCKET_VARIABLE);
    capture.dispose();
    await server?.dispose();
  })();
  try {
    server = await (dependencies.startServer ?? createContextServer)(capture.capture, {
      onFailure: () => {
        warn("Mikoto VS Code Context listener stopped.");
        void dispose().catch(() => warn("Mikoto VS Code Context cleanup failed."));
      },
    });
    // A failure may arrive while startup is settling. Never republish a dead
    // endpoint, and dispose the newly returned resource if that happened.
    if (disposed) await server.dispose();
    else {
      collection.persistent = false;
      collection.replace(SOCKET_VARIABLE, server.socketPath);
    }
  } catch {
    warn("Mikoto VS Code Context could not start.");
    await dispose().catch(() => warn("Mikoto VS Code Context cleanup failed."));
  }
  return { dispose };
}
