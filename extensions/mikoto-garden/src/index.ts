import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MikotoEventEmitter, MikotoPolicy } from "mikoto-types";
import { CapabilityRegistry, listenBindings } from "./capability-registry.ts";
import { CapabilityServer } from "./capability-server.ts";
import { ExecutorClient } from "./executor-client.ts";
import { obtainPolicy } from "./permissions.ts";
import { installGardenPrompt } from "./prompt.ts";
import { CONTRACT } from "./protocol.ts";
import { registerGardenTools, type ToolRuntime } from "./tools.ts";
import { GardenPresentation, registerGardenCommands } from "./ui.ts";

// Pi can load more than one copy of this extension, and each copy receives a
// different event-bus facade. We therefore keep an ownership map on globalThis,
// using Symbol.for so separately loaded module copies find the same map. The
// shared session manager is the session identity; claiming it prevents two
// copies from starting competing executors and capability servers. WeakMap
// avoids retaining a session after Pi releases it. Claim ownership before
// acquiring generation resources, including on tree navigation after a failed
// start.
const ownerKey = Symbol.for("mikoto-garden:session-owners");
const globals = globalThis as unknown as Record<symbol, unknown>;
const owners = (globals[ownerKey] ??= new WeakMap<object, object>()) as WeakMap<object, object>;
export default function garden(pi: ExtensionAPI): void {
  const owner = {};
  let ownedSession: object | undefined;
  const registry = new CapabilityRegistry();
  const ui = new GardenPresentation();
  const events: MikotoEventEmitter = pi.events;
  let policy: MikotoPolicy | undefined;
  let runtime: ToolRuntime | undefined;
  let server: CapabilityServer | undefined;
  let ready = false;
  let readiness = "initializing";
  let lifetime = new AbortController();
  let rotation: Promise<void> = Promise.resolve();
  const status = () =>
    `${readiness}; capabilities ${server?.endpoint ? "available" : "unavailable"}`;
  const current = () => {
    if (!ready || !runtime || runtime.lifetime.signal.aborted || !runtime.client.available) {
      throw new Error(
        `Command execution unavailable: ${readiness}. No unsandboxed fallback; resolve initialization and /reload.`,
      );
    }
    return runtime;
  };
  function guardBash(): void {
    const active = pi.getActiveTools();
    if (active.includes("bash")) pi.setActiveTools(active.filter((name) => name !== "bash"));
  }
  async function teardown(): Promise<void> {
    ready = false;
    const old = runtime;
    const oldServer = server;
    runtime = undefined;
    server = undefined;
    oldServer?.stopAdmitting();
    ui.reset();
    const warnings = (await old?.client.close()) ?? [];
    await oldServer?.close();
    for (const warning of warnings) ui.notify(warning, "warning");
  }
  async function start(ctx: ExtensionContext, generationLifetime: AbortController): Promise<void> {
    await teardown();
    if (generationLifetime.signal.aborted) return;
    ui.setContext(ctx);
    policy = obtainPolicy(events);
    const generation = randomUUID();
    readiness = "initializing";
    // Capabilities are attempted independently, including when Policy or the
    // execution platform is unavailable.
    const newServer = await CapabilityServer.start(registry, () => {
      if (lifetime !== generationLifetime || generationLifetime.signal.aborted) return;
      ready = false;
      ui.notify(
        "Garden capabilities lost; old jobs may retain stale environment values.",
        "warning",
      );
      const old = runtime;
      if (!old) return;
      readiness = "revoking capability grant";
      void old.client
        .request("revoke", {})
        .then(() => {
          if (runtime === old && !generationLifetime.signal.aborted) {
            ready = true;
            readiness = "ready";
          }
        })
        .catch(() => {
          if (runtime === old && !generationLifetime.signal.aborted) {
            readiness = "executor control failure; /reload required";
          }
        });
    });
    if (generationLifetime.signal.aborted) {
      await newServer?.close();
      return;
    }
    server = newServer;
    if (!server) {
      ui.notify("Garden capabilities unavailable; execution will still initialize.", "warning");
    }
    if (
      !policy ||
      process.platform !== "darwin" ||
      process.release.name !== "node" ||
      Number(process.versions.node.split(".")[0]) < 26
    ) {
      readiness = !policy ? "missing/invalid Policy snapshot" : "macOS with Node 26+ required";
      return;
    }
    let client: ExecutorClient;
    try {
      client = new ExecutorClient(
        generation,
        await realpath(process.execPath),
        (job) => {
          if (runtime?.generation !== generation || generationLifetime.signal.aborted) return;
          for (const controller of runtime.approvals.get(job.id) ?? []) controller.abort();
          ui.completed(job);
        },
        () => {
          if (generationLifetime.signal.aborted) return;
          ready = false;
          readiness = "executor disconnected; /reload required";
          generationLifetime.abort();
          ui.notify("Garden executor disconnected; /reload required.", "warning");
        },
      );
      runtime = {
        generation,
        lifetime: generationLifetime,
        client,
        endpoint: () => newServer?.endpoint,
        approvals: new Map(),
      };
      const initialEndpoint = newServer?.endpoint;
      await client.request(
        "init",
        {
          contract: CONTRACT,
          policy: policy.document(),
          runtimeParent: await realpath(tmpdir()),
          ...(initialEndpoint ? { endpoint: { port: initialEndpoint.port } } : {}),
        },
        20000,
        generationLifetime.signal,
      );
      if (initialEndpoint && !newServer?.endpoint) await client.request("revoke", {});
      generationLifetime.signal.throwIfAborted();
      ready = true;
      readiness = "ready";
    } catch {
      ready = false;
      readiness = "executor initialization failed; /reload required";
      const warnings = (await runtime?.client.close()) ?? [];
      runtime = undefined;
      // Failed initialization can still leave owned runtime artifacts behind.
      // Preserve the same cleanup diagnostics as an ordinary generation stop.
      for (const warning of warnings) ui.notify(warning, "warning");
    }
  }
  function rotate(ctx: ExtensionContext): Promise<void> {
    const session = ctx.sessionManager;
    const existing = owners.get(session);
    if (existing && existing !== owner) throw new Error("Duplicate Mikoto Garden instance");
    if (ownedSession && ownedSession !== session && owners.get(ownedSession) === owner) {
      owners.delete(ownedSession);
    }
    owners.set(session, owner);
    ownedSession = session;
    lifetime.abort();
    lifetime = new AbortController();
    const next = lifetime;
    rotation = rotation.catch(() => {}).then(() => start(ctx, next));
    return rotation;
  }
  const stopListeningBindings = listenBindings(pi, registry);
  registerGardenTools(pi, current, (id) => ui.collected(id));
  registerGardenCommands(
    pi,
    () => runtime,
    status,
    ui,
    () => server?.endpoint,
  );
  installGardenPrompt(pi, () => policy?.document());
  pi.on("session_start", async (_event, ctx) => {
    guardBash();
    await rotate(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await rotate(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    ui.setContext(ctx);
    guardBash();
  });
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash") {
      return {
        block: true,
        reason:
          "Model bash is disabled. Use exec_command; never bypass a denial or rejected escalation.",
      };
    }
  });
  // Deliberately no user_bash handler: !, !!, and RPC bash remain Pi-owned.
  pi.on("session_shutdown", async () => {
    lifetime.abort();
    await rotation.catch(() => {});
    await teardown();
    registry.close();
    stopListeningBindings();
    ui.close();
    policy = undefined;
    if (ownedSession && owners.get(ownedSession) === owner) owners.delete(ownedSession);
    ownedSession = undefined;
  });
}
