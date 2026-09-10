import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  MikotoEventPayload,
  MikotoGardenBindEvent,
  MikotoGardenBindResult,
} from "mikoto-types";

export function canonicalRoute(path: string): path is `/${string}` {
  return (
    path.length <= 256 &&
    /^\/(?:[A-Za-z0-9_.~-]+(?:\/[A-Za-z0-9_.~-]+)*)?$/.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..")
  );
}

export type Binding = {
  readonly id: string;
  readonly event: MikotoGardenBindEvent;
  readonly lifetime: AbortController;
};

export class CapabilityRegistry {
  private readonly routes = new Map<string, Binding>();
  private closed = false;

  bind<Body>(event: MikotoGardenBindEvent<Body>): MikotoGardenBindResult {
    if (this.closed) return { ok: false, reason: "Capability registry closed" };
    if (!event.owner.trim() || !canonicalRoute(event.path)) {
      return { ok: false, reason: "Invalid owner or canonical path" };
    }
    const key = `${event.method} ${event.path}`;
    if (this.routes.has(key)) return { ok: false, reason: "Route already bound" };
    const binding: Binding = {
      id: randomUUID(),
      event: Object.freeze({ ...event }) as unknown as MikotoGardenBindEvent,
      lifetime: new AbortController(),
    };
    this.routes.set(key, binding);
    return {
      ok: true,
      bindingId: binding.id,
      dispose: () => {
        if (this.routes.get(key) !== binding) return;
        this.routes.delete(key);
        binding.lifetime.abort();
      },
    };
  }

  find(method: string, path: string): Binding | undefined {
    return this.routes.get(`${method} ${path}`);
  }
  hasPath(path: string): boolean {
    return [...this.routes.values()].some((b) => b.event.path === path);
  }
  close(): void {
    this.closed = true;
    for (const binding of this.routes.values()) binding.lifetime.abort();
    this.routes.clear();
  }
}

export function listenBindings(pi: ExtensionAPI, registry: CapabilityRegistry): () => void {
  return pi.events.on("mikoto-garden:bind", (data) => {
    // The schema and handler are live references from trusted extension code.
    // Only the incoming HTTP body is parsed, not this typed bus envelope.
    const event = data as MikotoEventPayload<"mikoto-garden:bind">;
    const result = registry.bind(event);
    try {
      event.callback?.(result);
    } catch {
      /* A producer callback cannot remove another binding. */
    }
  });
}
