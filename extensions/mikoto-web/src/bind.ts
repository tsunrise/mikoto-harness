import type { MikotoEventEmitter, MikotoGardenBindEvent, MikotoGardenBindResult } from "mikoto-types";

export function disposeSafely(dispose: (() => void) | undefined): void {
  try { dispose?.(); } catch { /* Disposal is best-effort across the event bus. */ }
}

export function bind<Body>(
  events: MikotoEventEmitter,
  event: Omit<MikotoGardenBindEvent<Body>, "callback">,
  signal: AbortSignal,
  timeoutMs = 1000,
): Promise<(() => void) | undefined> {
  return new Promise((resolve) => {
    let accepted: Extract<MikotoGardenBindResult, { ok: true }> | undefined;
    let finished = false;
    let dispatching = true;
    let rejected = false;
    const finish = (success: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (!success) disposeSafely(accepted?.dispose);
      resolve(success ? accepted?.dispose : undefined);
    };
    const abort = () => finish(false);
    const timer = setTimeout(abort, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { finish(false); return; }
    try {
      events.emit("mikoto-garden:bind", {
        ...event,
        callback(result) {
          if (!result.ok) {
            rejected = true;
            if (!dispatching && !accepted) finish(false);
          } else if (accepted?.bindingId === result.bindingId) {
            // Repeating the same acknowledgement must not dispose our route.
            return;
          } else if (finished || accepted || signal.aborted) {
            disposeSafely(result.dispose);
          } else {
            accepted = result;
            if (!dispatching) finish(true);
          }
        },
      });
      dispatching = false;
      if (accepted) finish(true);
      else if (rejected) finish(false);
    } catch {
      // A listener can acknowledge and then throw. Do not publish that route.
      dispatching = false;
      finish(false);
    }
  });
}
