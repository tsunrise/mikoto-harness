import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  MikotoEventPayload,
  MikotoPolicy,
  MikotoPolicyDocument,
} from "mikoto-types";
import {
  PERMISSION_PATH,
  type MikotoPolicyDocumentLoader,
} from "./config.ts";
import {
  evaluateRead,
  evaluateWrite,
} from "./evaluate.ts";
import { resolveToolPath } from "./utils.ts";

export function provideExtensionsApi(
  loader: MikotoPolicyDocumentLoader,
  pi: ExtensionAPI,
) {
  let policy: MikotoPolicy | undefined;

  // Unlike built-in tools, custom `events.on` doesn't carry ctx for `cwd` and `isProjectTrusted`,
  // so we have to parse the policy on session start.
  pi.on("session_start", async (_event, ctx) => {
    policy = undefined;
    const loaded = await loader.load(
      ctx.cwd,
      ctx.isProjectTrusted(),
    );
    policy = createPolicy(loaded.document, ctx.cwd);
  });

  const eventName = "mikoto-policy:get-policy";
  // We register listener here instead of `session_start` to make sure we only subscribe to the event
  // one time. However, if `session_start` is not finished, callback would not be called.
  pi.events.on(eventName, (data) => {
    const event = data as MikotoEventPayload<typeof eventName>;
    if (!policy) return;

    try {
      void Promise.resolve(event.callback(policy)).catch(
        logCallbackError,
      );
    } catch (error) {
      logCallbackError(error);
    }
  });
}

function createPolicy(
  document: MikotoPolicyDocument,
  cwd: string,
): MikotoPolicy {
  return Object.freeze({
    document: () => document,
    permissionMdPath: PERMISSION_PATH,
    resolveToolPath: (path: string) => resolveToolPath(path, cwd),
    evaluateRead: async (path: string) =>
      evaluateRead(document, path, "file"),
    evaluateReadTree: async (path: string) =>
      evaluateRead(document, path, "directory"),
    evaluateWrite: async (path: string) =>
      evaluateWrite(document, path),
  });
}

function logCallbackError(error: unknown): void {
  console.error("Mikoto Policy consumer callback failed:", error);
}
