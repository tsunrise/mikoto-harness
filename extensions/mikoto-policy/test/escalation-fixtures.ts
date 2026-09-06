import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, type KeyId } from "@earendil-works/pi-tui";
import type { EscalationRequest } from "../src/escalate/broker.ts";
import type { EscalationComponent } from "../src/escalate/ui.ts";

export const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

export function keys(overrides: Record<string, KeyId[]> = {}): KeybindingsManager {
  const bindings: Record<string, KeyId[]> = {
    "tui.select.confirm": ["enter"], "tui.input.submit": ["enter"],
    "tui.select.cancel": ["escape", "ctrl+c"], "app.interrupt": ["escape"],
    "tui.select.up": ["up"], "tui.select.down": ["down"],
    "tui.select.pageUp": ["pageUp"], "tui.select.pageDown": ["pageDown"],
    ...overrides,
  };
  return {
    matches: (data: string, action: string) => bindings[action]?.some((key) => matchesKey(data, key)) ?? false,
    getKeys: (action: string) => bindings[action] ?? [],
  } as unknown as KeybindingsManager;
}

export const tui = { requestRender() {}, terminal: { rows: 18 } } as unknown as TUI;
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export function request(id = "1", signal = new AbortController().signal): EscalationRequest {
  return { requestId: id, source: "Test", verb: "Write", subject: `/target/${id}`, why: "Needed", signal };
}

export function harness() {
  const bus = new EventEmitter();
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const entries: unknown[] = [];
  const dialogs: EscalationComponent[] = [];
  let interrupted = 0;
  let factoryBarrier: (() => Promise<void>) | undefined;
  const pi = {
    events: {
      emit: (name: string, event: unknown) => { bus.emit(name, event); },
      on(name: string, listener: (data: unknown) => void) {
        bus.on(name, listener);
        return () => { bus.off(name, listener); };
      },
    },
    appendEntry: (_name: string, data: unknown) => { entries.push(structuredClone(data)); },
    registerEntryRenderer() {},
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      handlers.set(name, [...handlers.get(name) ?? [], handler]);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui", hasUI: true, cwd: process.cwd(), isProjectTrusted: () => false,
    abort() { interrupted++; },
    ui: {
      async custom(factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) {
        await factoryBarrier?.();
        return new Promise((resolve) => {
          const component = factory(tui, theme, keys(), resolve) as EscalationComponent;
          dialogs.push(component);
          component.focused = true;
          component.render(80);
        });
      },
    },
  } as unknown as ExtensionContext;
  return {
    pi, ctx, bus, entries, dialogs,
    get interrupted() { return interrupted; },
    delayFactory(barrier: () => Promise<void>) { factoryBarrier = barrier; },
    async emit(name: string) {
      for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
    },
  };
}
