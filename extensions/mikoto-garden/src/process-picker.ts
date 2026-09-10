import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { Job, Responses } from "./protocol.ts";
import { boundedText, sanitize } from "./executor/output-store.ts";

const live = (job: Job) => job.state === "running" || job.state === "stopping";
const sortJobs = (jobs: Job[]) =>
  [...jobs].sort(
    (a, b) => Number(live(b)) - Number(live(a)) || b.started - a.started || b.id - a.id,
  );

export function compactJob(job: Job, width: number): string {
  const state = job.exit_signal ?? (job.exit_code !== null ? `exit ${job.exit_code}` : job.state);
  return truncateToWidth(
    `${job.id} ${job.mode === "unsandboxed" ? "host" : "sandbox"} ${state} · ${sanitize(job.cmd).replaceAll("\n", " ")}`,
    width,
    "…",
  );
}

export function jobDetail(job: Job, tail?: string): string {
  // Individual list(id) replies contain the full command, unlike the bounded
  // list summaries. Never label a list-row abbreviation as the exact command.
  const command = job.cmd.replace(
    /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Z}]/gu,
    (char) => (char === " " || char === "\n" ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`),
  );
  return sanitize(
    [
      `Session ${job.id} · ${job.mode} · ${job.state}`,
      `unread=${job.unread} · stdin=${job.stdinOpen ? "open" : "closed"} · ${(((job.ended ?? Date.now()) - job.started) / 1000).toFixed(1)}s`,
      ...(job.exit_code !== null ? [`Exit: ${job.exit_code}`] : []),
      ...(job.exit_signal !== null ? [`Signal: ${job.exit_signal}`] : []),
      `Cwd: ${job.cwd}`,
      "Command (controls escaped; newlines preserved):",
      command,
      "",
      "Combined output tail (non-consuming; may be truncated):",
      tail || "(no retained output)",
    ].join("\n"),
  );
}

/** A local snapshot browser. No automatic polling, input delivery, or model messages. */
export class ProcessPicker {
  private jobs: Job[];
  private selected = 0;
  private detail: { job: Job; tail?: string } | undefined;
  private armed: number | undefined;
  private offset = 0;
  private maxOffset = 0;
  private busy = false;
  private closed = false;
  private inPaste = false;
  private notice: string;
  private readonly tui: Pick<TUI, "terminal" | "requestRender">;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: () => void;
  private readonly read: (id?: number) => Promise<Responses["list"]>;
  private readonly stop: (id: number) => Promise<string[]>;

  constructor(
    result: Responses["list"] | undefined,
    problem: string | undefined,
    initialId: number | undefined,
    tui: Pick<TUI, "terminal" | "requestRender">,
    theme: Theme,
    keys: KeybindingsManager,
    done: () => void,
    read: (id?: number) => Promise<Responses["list"]>,
    stop: (id: number) => Promise<string[]>,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.read = read;
    this.stop = stop;
    this.jobs = sortJobs(result?.jobs ?? []);
    this.notice = problem ?? "";
    if (initialId !== undefined && result?.jobs[0]) {
      this.detail = { job: result.jobs[0], tail: result.tail };
    }
  }

  private pageSize(): number {
    return Math.max(1, this.tui.terminal.rows - 8);
  }

  private navigationDelta(data: string): number {
    if (this.keys.matches(data, "tui.select.up")) return -1;
    if (this.keys.matches(data, "tui.select.down")) return 1;
    if (this.keys.matches(data, "tui.select.pageUp")) return -this.pageSize();
    if (this.keys.matches(data, "tui.select.pageDown")) return this.pageSize();
    return 0;
  }

  private async load(id?: number, arm = false): Promise<void> {
    this.busy = true;
    this.notice = "";
    this.tui.requestRender();
    try {
      const result = await this.read(id);
      if (this.closed) return;
      if (id !== undefined) {
        const job = result.jobs.find((entry) => entry.id === id);
        if (!job) throw new Error("expired");
        this.detail = { job, tail: result.tail };
        this.armed = arm && live(job) ? id : undefined;
        if (arm && !live(job)) this.notice = "This job has already finished; nothing was stopped.";
      } else {
        const previous = this.detail?.job.id ?? this.jobs[this.selected]?.id;
        this.jobs = sortJobs(result.jobs);
        this.selected = Math.max(
          0,
          this.jobs.findIndex((job) => job.id === previous),
        );
        this.detail = undefined;
        this.armed = undefined;
      }
      this.offset = 0;
    } catch {
      // Executor errors are not a credential-safe display API.
      this.armed = undefined;
      this.notice = "Job unavailable/expired or generation changed. Close and reopen /ps.";
    } finally {
      this.busy = false;
      if (!this.closed) this.tui.requestRender();
    }
  }

  private async confirmStop(): Promise<void> {
    const id = this.armed;
    if (id === undefined) return;
    this.armed = undefined;
    this.busy = true;
    this.tui.requestRender();
    try {
      const warnings = await this.stop(id);
      if (this.closed) return;
      await this.load(id);
      this.notice = warnings.length
        ? boundedText(sanitize(warnings.join("\n")), 2048)
        : `Stopped session ${id}.`;
    } catch {
      this.notice = "Stop not confirmed. Close and reopen /ps to check the current generation.";
    } finally {
      this.busy = false;
      if (!this.closed) this.tui.requestRender();
    }
  }

  handleInput(data: string): void {
    if (this.closed) return;
    // A pasted `d` followed by a separately delivered Enter must not stop a
    // process. Treat every chunk of bracketed paste as data, not actions.
    const paste = this.inPaste || data.includes("\x1b[200~");
    if (data.includes("\x1b[200~")) this.inPaste = true;
    if (data.includes("\x1b[201~")) this.inPaste = false;
    if (paste) return;
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.armed !== undefined) this.armed = undefined;
      else if (this.detail && !this.busy) {
        // Navigation must not depend on a healthy executor. If refreshing the
        // list fails after a reload, the next Escape must still close the view.
        this.detail = undefined;
        void this.load();
        return;
      } else {
        this.closed = true;
        this.done();
        return;
      }
    } else if (this.busy) return;
    else if (data === "r" && this.armed === undefined) {
      void this.load(this.detail?.job.id);
      return;
    } else if (data === "d" && this.armed === undefined) {
      const job = this.detail?.job ?? this.jobs[this.selected];
      if (job && live(job)) {
        void this.load(job.id, true);
        return;
      }
      this.notice = "Select a running job to stop.";
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      if (this.armed !== undefined) {
        void this.confirmStop();
        return;
      }
      if (!this.detail && this.jobs[this.selected]) {
        void this.load(this.jobs[this.selected]!.id);
        return;
      }
    } else {
      const delta = this.navigationDelta(data);
      if (this.detail) this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + delta));
      else this.selected = Math.max(0, Math.min(this.jobs.length - 1, this.selected + delta));
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const th = this.theme;
    const body: string[] = [];
    if (this.detail) {
      const lines = wrapTextWithAnsi(jobDetail(this.detail.job, this.detail.tail), width);
      this.maxOffset = Math.max(0, lines.length - this.pageSize());
      this.offset = Math.min(this.offset, this.maxOffset);
      body.push(...lines.slice(this.offset, this.offset + this.pageSize()));
    } else {
      const start = Math.max(0, this.selected - this.pageSize() + 1);
      for (
        let index = start;
        index < Math.min(this.jobs.length, start + this.pageSize());
        index++
      ) {
        const row = `${index === this.selected ? "› " : "  "}${compactJob(this.jobs[index]!, Math.max(1, width - 2))}`;
        body.push(index === this.selected ? th.fg("accent", row) : row);
      }
      if (!this.jobs.length) body.push("No managed processes.");
    }
    const running = this.jobs.filter(live).length;
    const hint = (action: "tui.select.confirm" | "tui.select.cancel") =>
      this.keys.getKeys(action).join("/");
    const content = [
      th.fg(
        "dim",
        this.detail
          ? "Snapshot · output preview does not consume unread data"
          : `${running} running/stopping · ${this.jobs.length - running} completed · snapshot`,
      ),
      ...body,
      ...(this.busy ? [th.fg("dim", "Working…")] : []),
      ...(this.notice ? [th.fg("warning", this.notice.replaceAll("\n", " · "))] : []),
      ...(this.armed !== undefined
        ? [
            th.fg(
              "warning",
              `Stop session ${this.armed}? ${hint("tui.select.confirm")} confirms · ${hint("tui.select.cancel")} cancels`,
            ),
          ]
        : [
            th.fg(
              "dim",
              this.detail
                ? `↑↓ / PgUp/PgDn scroll · r refresh · d stop · ${hint("tui.select.cancel")} back`
                : `↑↓ select · ${hint("tui.select.confirm")} detail/output · d then ${hint("tui.select.confirm")} stop · r refresh · ${hint("tui.select.cancel")} close`,
            ),
          ]),
    ];
    const border = (text: string) => th.fg("borderAccent", text);
    if (width === 1) return [border("─"), ...content.map(() => border("│")), border("─")];
    const innerWidth = width - 2;
    const title = truncateToWidth(" Background Commands ", innerWidth, "…");
    const top =
      border("╭") +
      th.fg("accent", th.bold(title)) +
      border("─".repeat(Math.max(0, innerWidth - visibleWidth(title))) + "╮");
    const padding = width >= 4 ? 1 : 0;
    const contentWidth = Math.max(0, innerWidth - padding * 2);
    const framed = content.map((line) => {
      const clipped = truncateToWidth(line, contentWidth, "");
      return (
        border("│") +
        " ".repeat(padding) +
        clipped +
        " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped))) +
        " ".repeat(padding) +
        border("│")
      );
    });
    return [top, ...framed, border(`╰${"─".repeat(innerWidth)}╯`)];
  }

  invalidate(): void {
    /* Rewrap on every render, including theme/width changes. */
  }
}
