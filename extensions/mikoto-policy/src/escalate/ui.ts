import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input, matchesKey, parseKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type Focusable, type TUI,
} from "@earendil-works/pi-tui";
import type { MikotoEscalationResult, MikotoEventEmitter } from "mikoto-types";

/** Escape, rather than remove, characters that could disguise the scope. */
export function inertText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Z}]/gu,
    (char) => char === " " ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

const display = (text: string) => text === "" ? "(empty)" : inertText(text);
export class EscalationComponent implements Component, Focusable {
  private selected: "approve" | "reject" = "reject";
  private state: "decision" | "reason" = "decision";
  private readonly input = new Input();
  private inPaste = false;
  private _focused = false;
  private completed = false;
  private visible = false;
  private readonly toolName: string;
  private readonly tui: Pick<TUI, "requestRender" | "terminal">;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: (result: MikotoEscalationResult) => void;
  private readonly onVisible: () => void;

  constructor(
    toolName: string,
    tui: Pick<TUI, "requestRender" | "terminal">,
    theme: Theme,
    keys: KeybindingsManager,
    done: (result: MikotoEscalationResult) => void,
    onVisible: () => void = () => {},
  ) {
    this.toolName = toolName;
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.onVisible = onVisible;
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.state === "reason";
  }

  private complete(result: MikotoEscalationResult): void {
    if (this.completed) return;
    this.completed = true;
    this.done(result);
  }

  handleInput(data: string): void {
    if (this.completed) return;
    // Bracketed paste may arrive in multiple chunks. None of them are actions,
    // even if a chunk consists of Enter or an escape sequence.
    const paste = this.inPaste || data.includes("\x1b[200~");
    if (data.includes("\x1b[200~")) this.inPaste = true;
    if (data.includes("\x1b[201~")) this.inPaste = false;
    const key = parseKey(data);
    const printable = key !== undefined && (Array.from(key).length === 1 || key === "space");
    if (!paste && (this.keys.matches(data, "tui.select.cancel") ||
        this.keys.matches(data, "app.interrupt") || matchesKey(data, "escape"))) {
      if (this.state === "reason") {
        // Going back is navigation, not a decision. Keep the draft and our place
        // in the broker queue until submission.
        this.state = "decision";
        this.focused = this._focused;
      } else {
        this.complete({ decision: "reject", cause: "interrupted" });
      }
    } else if (this.state === "reason") {
      if (!paste && !printable && (this.keys.matches(data, "tui.input.submit") ||
          this.keys.matches(data, "tui.select.confirm"))) {
        const reason = inertText(this.input.getValue()).trim();
        this.complete({ decision: "reject", cause: "user", ...(reason ? { reason } : {}) });
      } else {
        this.input.handleInput(data);
        const value = this.input.getValue();
        const safe = inertText(value);
        if (safe !== value) this.input.setValue(safe);
      }
    } else if (!paste && !printable) {
      if (this.keys.matches(data, "tui.select.confirm")) {
        if (this.selected === "approve") {
          this.complete({ decision: "approve" });
        } else {
          this.state = "reason";
          this.focused = this._focused;
        }
      } else if (matchesKey(data, "left")) {
        this.selected = "approve";
      } else if (matchesKey(data, "right")) {
        this.selected = "reject";
      }
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (!this.visible) {
      this.visible = true;
      this.onVisible();
    }
    const th = this.theme;
    // Pi's custom-message label gives us violet accents in both built-in
    // themes, while respecting user theme overrides.
    const violet = (text: string) => th.fg("customMessageLabel", text);
    const muted = (text: string) => th.fg("muted", text);
    // Some terminals give the torii one cell even though its glyph paints into
    // two. Leave breathing room after it and keep it off the frame's lines:
    // emoji-width differences must not move the frame's right-hand corners.
    const title = `⛩️  ${violet(th.bold("Escalation"))}`;
    // A readable card is nicer than stretching a rule across an ultrawide
    // terminal. On small terminals, give the space back to the tool name.
    const framed = width >= 44 && this.tui.terminal.rows >= 12;
    const panelWidth = Math.min(width, 104);
    const innerWidth = framed ? panelWidth - 6 : panelWidth;
    const fit = (line: string) => truncateToWidth(line, innerWidth);
    const hint = (key: string, action: string) => `${violet(th.bold(key))}${muted(` ${action}`)}`;
    const separator = muted(" · ");
    const help = (line: string) => innerWidth >= 20 ? wrapTextWithAnsi(line, innerWidth) : [fit(line)];
    const panel = (body: string[], footer: string[]): string[] => {
      if (!framed) return [title, ...body, ...footer].map(fit);
      const row = (line: string) => {
        const content = fit(line);
        const padded = `  ${content}${" ".repeat(innerWidth - visibleWidth(content))}  `;
        return `${violet("│")}${padded}${violet("│")}`;
      };
      return [
        fit(title),
        violet(`╭${"─".repeat(panelWidth - 2)}╮`),
        ...body.map(row),
        violet(`├${"─".repeat(panelWidth - 2)}┤`),
        ...footer.map(row),
        violet(`╰${"─".repeat(panelWidth - 2)}╯`),
      ];
    };
    if (this.state === "reason") {
      return panel([
        ...(framed ? [""] : []),
        violet(th.bold("Reason for the model")),
        muted(th.italic("Optional · leave blank to skip")),
        "",
        ...this.input.render(innerWidth).map((line) => th.fg("text", line)),
        ...(framed ? [""] : []),
      ], help(
        hint(this.keys.getKeys("tui.input.submit").join("/"), "submit rejection") +
          separator + hint("Esc", "back"),
      ));
    }

    const choice = (value: "approve" | "reject", label: string) =>
      this.selected === value
        ? violet(th.inverse(th.bold(` › ${label} `)))
        : th.fg("text", `   ${label} `);
    const approve = choice("approve", "Approve");
    const reject = choice("reject", "Reject");
    const choices = `${approve}   ${reject}`;
    const footer = [
      ...(visibleWidth(choices) <= innerWidth ? [choices] : [approve, reject]),
      ...help(hint("←→", "choose") + separator +
        hint(this.keys.getKeys("tui.select.confirm").join("/"), "confirm") +
        separator + hint("Esc", "interrupt")),
    ];
    return panel([th.fg("text", fit(display(this.toolName)))], footer);
  }

  invalidate(): void { this.input.invalidate(); }
}

export async function showEscalation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  toolName: string,
  signal: AbortSignal,
): Promise<MikotoEscalationResult> {
  let close: ((result: MikotoEscalationResult) => void) | undefined;
  const cancelled: MikotoEscalationResult = { decision: "reject", cause: "cancelled" };
  const abort = () => close?.(cancelled);
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) return cancelled;
    const result = await ctx.ui.custom<MikotoEscalationResult>((tui, theme, keys, done) => {
      close = done;
      const component = new EscalationComponent(toolName, tui, theme, keys, done, () => {
        if (!signal.aborted) {
          const events: MikotoEventEmitter = pi.events;
          try {
            events.emit("mikoto-sound:sound", { effect: "require-attention" });
          } catch (error) {
            console.error("Mikoto Policy attention event failed:", error);
          }
        }
      });
      // Pi's custom() checks its closed flag before mounting the returned
      // component, so cancellation in this factory cannot resurrect the UI.
      if (signal.aborted) done(cancelled);
      return component;
    });
    return signal.aborted ? cancelled : result ?? { decision: "reject", cause: "error" };
  } finally {
    signal.removeEventListener("abort", abort);
    close = undefined;
  }
}
