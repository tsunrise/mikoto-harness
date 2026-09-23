import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { endpointFromEnvironment, request } from "./client.ts";
import { captureContext, type CaptureResult } from "./context.ts";

type Dependencies = {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  request?: typeof request;
  capture?: typeof captureContext;
};

export default function mikotoVSCodeContext(pi: ExtensionAPI, dependencies: Dependencies = {}) {
  const endpoint = endpointFromEnvironment(dependencies.env, dependencies.platform);
  let enabled = false;
  let initialized = false;
  let generation = 0;
  let transitions = Promise.resolve();
  const pending = new Set<AbortController>();

  const invalidate = () => {
    generation++;
    for (const controller of pending) controller.abort();
    pending.clear();
  };
  const serial = (action: () => Promise<void>) => {
    transitions = transitions.then(action, action);
    return transitions;
  };
  const notify = (ctx: ExtensionContext, text: string) => {
    if (ctx.hasUI) ctx.ui.notify(text, "info");
  };
  const handshake = async () => {
    if (!endpoint) return false;
    const controller = new AbortController();
    pending.add(controller);
    const started = generation;
    try {
      const response = await (dependencies.request ?? request)(endpoint, "ping", controller.signal);
      return !controller.signal.aborted && generation === started && response.status === "ok";
    } catch {
      return false;
    } finally {
      pending.delete(controller);
    }
  };
  const capture = async (ctx: ExtensionContext): Promise<CaptureResult> => {
    if (!enabled || !endpoint) return { status: "empty" };
    const started = generation;
    const controller = new AbortController();
    const abort = () => controller.abort();
    // ExtensionContext may expose signal through a getter. Remove our listener
    // from the same signal we subscribed to, even after the turn has changed.
    const signal = ctx.signal;
    pending.add(controller);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const result = await (dependencies.capture ?? captureContext)(endpoint, ctx.cwd, controller.signal);
      return enabled && started === generation && !controller.signal.aborted ? result : { status: "aborted" };
    } finally {
      signal?.removeEventListener("abort", abort);
      pending.delete(controller);
    }
  };

  pi.on("session_start", () => {
    invalidate();
    return serial(async () => {
      if (initialized) return;
      initialized = true;
      enabled = await handshake();
    });
  });
  pi.on("session_shutdown", () => { invalidate(); });

  pi.registerCommand("vscode", {
    description: "Toggle or preview Mikoto VS Code editor context",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "toggle") {
        await serial(async () => {
          if (enabled) {
            enabled = false;
            invalidate();
            notify(ctx, "VS Code context disabled. Previously captured context remains in the session.");
          } else {
            enabled = await handshake();
            notify(ctx, enabled ? "VS Code context enabled." : "VS Code context is unavailable.");
          }
        });
      } else if (command === "preview") {
        const started = generation;
        await transitions;
        if (started !== generation) return;
        if (!enabled) { notify(ctx, "VS Code context is disabled."); return; }
        const result = await capture(ctx);
        if (result.status === "aborted") return;
        const messages = {
          empty: "No matching VS Code editor context for this working directory.",
          unavailable: "VS Code context is disconnected or unavailable.",
          malformed: "VS Code returned malformed context.",
        };
        notify(ctx, result.status === "context" ? result.formatted.content : messages[result.status]);
      } else {
        notify(ctx, "Usage: /vscode toggle | /vscode preview");
      }
    },
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const started = generation;
    await transitions;
    if (!enabled || started !== generation) return;
    const result = await capture(ctx);
    if (result.status !== "context") return;
    return {
      message: {
        customType: "vscode-context",
        content: result.formatted.content,
        display: false,
        details: result.formatted.details,
      },
    };
  });
}
