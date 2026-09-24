import {
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, wrapTextWithAnsi, truncateToWidth } from "@earendil-works/pi-tui";
import { z } from "zod";
import { CONTRACT, type Job, type Responses } from "./protocol.ts";
import type { ToolRuntime } from "./tools.ts";
import type { Endpoint } from "./capability-server.ts";
import { boundedText, sanitize, OUTPUT_LIMITS } from "./executor/output-store.ts";
import { ProcessPicker, compactJob, jobDetail } from "./process-picker.ts";

const Details = z.object({
  job: z.object({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    mode: z.enum(["sandboxed", "unsandboxed"]),
    exit_code: z.number().int().nullable(),
    exit_signal: z.string().max(32).nullable(),
  }),
  yielded: z.boolean(),
  output: z.string().max(50 * 1024),
  wall_ms: z.number().nonnegative().finite(),
  omitted: z.number().nonnegative().finite(),
  log: z.string().max(4096),
  logCapped: z.boolean(),
  capabilities: z.boolean(),
});
type DisplayDetails = z.infer<typeof Details>;
type RowKind = "command" | "stop";
class CommandRow {
  args: Record<string, unknown> = {};
  details: DisplayDetails | undefined;
  expanded = false;
  error = false;
  partial = true;
  fallback = "";
  theme: Theme;
  readonly kind: RowKind;
  private cached: { width: number; lines: string[] } | undefined;
  constructor(theme: Theme, kind: RowKind) {
    this.theme = theme;
    this.kind = kind;
  }
  invalidate(): void {
    this.cached = undefined;
  }
  render(width: number): string[] {
    if (width <= 0) return [];
    // Pi renders settled transcript rows again while other content streams.
    // Reuse the whole row until its data, theme, expansion, or width changes.
    if (this.cached?.width === width) return this.cached.lines;
    const padding = width >= 3 ? 1 : 0;
    const theme = this.theme;
    const data = this.details;
    // A stopped command ending by signal is the requested outcome.
    const failed =
      this.error ||
      (this.kind === "command" &&
        !this.partial &&
        !!data &&
        !data.yielded &&
        (data.job.exit_signal !== null || data.job.exit_code !== 0));
    const command = typeof this.args.cmd === "string" ? this.args.cmd : undefined;
    const elevated = !!data && data.job.mode === "unsandboxed";
    const background = !!data && data.yielded && !this.error;
    let title: string;
    if (this.kind === "stop") {
      const session = sanitize(String(this.args.session_id ?? "")).slice(0, 64);
      title = theme.fg("toolTitle", theme.bold(`stop_command ${session}`));
    } else if (command !== undefined) {
      const approvalBadge = elevated ? theme.bold(theme.fg("warning", "E")) : "";
      const commandText = `$ ${sanitize(command)}`;
      title = approvalBadge + theme.fg("toolTitle", theme.bold(commandText));
    } else {
      let action = "wait / collect output (no input)";
      if (this.args.chars === "\u0003") {
        action = "interrupt";
      } else if (this.args.close_stdin) {
        action = "input/EOF";
      } else if (this.args.chars) {
        action = "input";
      }
      const session = sanitize(String(this.args.session_id ?? "")).slice(0, 64);
      title = theme.fg("toolTitle", theme.bold(`write_stdin ${session} · ${action}`));
    }
    let backgroundColor: Parameters<Theme["bg"]>[0] = "toolSuccessBg";
    if (failed) {
      backgroundColor = "toolErrorBg";
    } else if (this.partial || background) {
      backgroundColor = "toolPendingBg";
    }
    const box = new Box(padding, 1, (text) => theme.bg(backgroundColor, text));
    box.addChild(new Text(title, 0, 0));
    if (!data && this.args.sandbox_permissions === "require_escalated") {
      box.addChild(
        new Text(
          theme.fg(
            this.error ? "error" : "warning",
            this.error
              ? "Escalation failed/rejected — not approved execution"
              : "Awaiting approval",
          ),
          0,
          0,
        ),
      );
    }
    const output = sanitize(data?.output ?? this.fallback);
    const lines = wrapTextWithAnsi(output, Math.max(1, width - 2 * padding));
    if (output) {
      box.addChild(
        new Text(
          theme.fg("toolOutput", (this.expanded ? lines : lines.slice(-5)).join("\n")),
          0,
          0,
        ),
      );
    }
    if (data) {
      let status: string;
      if (this.partial) {
        status = "running";
      } else if (data.yielded) {
        status = `session ${data.job.id} running`;
      } else if (data.job.exit_signal && data.job.exit_code === null) {
        status = data.job.exit_signal;
      } else {
        status = `exit ${data.job.exit_code}`;
      }
      const hints = [
        `${(data.wall_ms / 1000).toFixed(2)}s`,
        status,
        ...(!data.capabilities ? ["capabilities unavailable"] : []),
        ...(data.omitted ? [`${data.omitted} bytes omitted`] : []),
        ...(data.omitted || data.logCapped
          ? [`log: ${sanitize(data.log)}${data.logCapped ? " (capped)" : ""}`]
          : []),
      ];
      if (!this.expanded && lines.length > 5) hints.push(keyHint("app.tools.expand", "to expand"));
      box.addChild(new Text(theme.fg("dim", hints.join(" · ")), 0, 0));
    }
    const rendered = box.render(width).map((line) => truncateToWidth(line, width, ""));
    this.cached = { width, lines: rendered };
    return rendered;
  }
}
export function gardenRenderers(
  kind: RowKind = "command",
): Pick<ToolDefinition, "renderShell" | "renderCall" | "renderResult"> {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const row =
        context.state.gardenRow instanceof CommandRow
          ? context.state.gardenRow
          : new CommandRow(theme, kind);
      row.args = args;
      row.theme = theme;
      row.error = context.isError;
      row.partial = context.isPartial;
      row.invalidate();
      context.state.gardenRow = row;
      return row;
    },
    renderResult(result, options, theme, context) {
      const row = context.state.gardenRow as CommandRow;
      row.theme = theme;
      row.expanded = options.expanded;
      row.partial = options.isPartial;
      row.error = context.isError;
      const parsed = Details.safeParse(result.details);
      row.details = parsed.success ? parsed.data : undefined;
      row.fallback = boundedText(
        result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n"),
        50 * 1024,
      );
      row.invalidate();
      return new Container();
    },
  };
}
export class GardenPresentation {
  private context: ExtensionContext | undefined;
  private completions: { id: number; command: string }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  setContext(ctx: ExtensionContext): void {
    this.context = ctx;
  }
  notify(text: string, type: "info" | "warning" | "error" = "info"): boolean {
    if (!this.context?.hasUI) return false;
    this.context.ui.notify(sanitize(text), type);
    return true;
  }
  completed(job: Job): void {
    if (!job.disclosed) return;
    const command = Array.from(sanitize(job.cmd).replace(/\s+/g, " ").trim())
      .slice(0, 64)
      .join("");
    this.completions.push({ id: job.id, command });
    this.completions = this.completions.slice(-64);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      const message = this.completions
        .map(({ id, command }) => `Completed: ${id} ${command}`)
        .join("\n");
      this.notify(message);
      this.completions = [];
    }, 250);
  }
  collected(id: number): void {
    // A final tool result can arrive during the coalescing delay. Do not tell
    // the user to preview/collect a job that the agent has already retired.
    this.completions = this.completions.filter((pending) => pending.id !== id);
    if (!this.completions.length) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.completions = [];
  }
  close(): void {
    this.reset();
    this.context = undefined;
  }
}
export function registerGardenCommands(
  pi: ExtensionAPI,
  runtime: () => ToolRuntime | undefined,
  status: () => string,
  ui: GardenPresentation,
  endpoint: () => Endpoint | undefined,
): void {
  async function inspect(args: string, command: string) {
    const value = args.trim();
    if (value && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
      throw new Error(`Usage: /${command} [managed-id]`);
    }
    const current = runtime();
    let result: Responses["list"] | undefined;
    let problem: string | undefined;
    if (current?.client.available && !current.lifetime.signal.aborted) {
      try {
        result = await current.client.request("list", value ? { id: Number(value) } : {});
      } catch {
        problem = value
          ? `Session ${value} unknown/expired or executor unavailable.`
          : "Process list unavailable.";
      }
    } else problem = "Process list unavailable: executor not running.";
    if (runtime() !== current) throw new Error(`Garden generation changed; run /${command} again.`);
    return { current, result, problem };
  }
  function boundedDisplay(text: string, bytes: number): string {
    const safe = sanitize(text);
    const bounded = boundedText(safe, bytes - 128);
    return bounded === safe
      ? safe
      : `${bounded}\n[Display truncated; select an individual managed ID for more detail.]`;
  }
  pi.registerCommand("ps", {
    description: "Mikoto Garden job picker; Enter previews output, d then Enter stops a job",
    async handler(args, ctx) {
      ui.setContext(ctx);
      const { current, result, problem } = await inspect(args, "ps");
      if (ctx.mode === "tui") {
        await ctx.ui.custom<void>(
          (tui, theme, keys, done) =>
            new ProcessPicker(
              result,
              problem,
              args.trim() ? Number(args.trim()) : undefined,
              tui,
              theme,
              keys,
              done,
              async (id) => {
                if (!current || runtime() !== current || current.lifetime.signal.aborted) {
                  throw new Error("stale");
                }
                const next = await current.client.request("list", id === undefined ? {} : { id });
                if (runtime() !== current || current.lifetime.signal.aborted) {
                  throw new Error("stale");
                }
                return next;
              },
              async (id) => {
                if (!current || runtime() !== current || current.lifetime.signal.aborted) {
                  throw new Error("stale");
                }
                for (const controller of current.approvals.get(id) ?? []) controller.abort();
                const stopped = await current.client.request("stop", { id }, 15000);
                // Cleanup uncertainty still matters if the user closed the picker
                // while stop was in flight. Do not bury warnings in a retired view.
                if (stopped.warnings.length) ui.notify(stopped.warnings.join("\n"), "warning");
                if (runtime() !== current || current.lifetime.signal.aborted) {
                  throw new Error("stale");
                }
                return stopped.warnings;
              },
            ),
          { overlay: true, overlayOptions: { width: "90%", margin: 1 } },
        );
        return;
      }
      const jobs = result?.jobs ?? [];
      ui.notify(
        boundedDisplay(
          [
            `Mikoto Garden: ${status()}`,
            ...(problem ? [problem] : []),
            ...(!problem && !jobs.length ? ["No managed processes."] : []),
            ...(args.trim() && jobs[0]
              ? [jobDetail(jobs[0], result?.tail)]
              : jobs.map((job) => compactJob(job, 120))),
            "/ps <id> previews output without consuming it",
          ].join("\n"),
          24 * 1024,
        ),
        problem ? "warning" : "info",
      );
    },
  });
  pi.registerCommand("ps:debug", {
    description: "Mikoto Garden debug snapshot, including the capability bearer token (TUI only)",
    async handler(args, ctx) {
      ui.setContext(ctx);
      // A credential-bearing diagnostic belongs in an explicit, transient
      // local view, never a notification, saved session entry, or model message.
      if (ctx.mode !== "tui") {
        ui.notify("Garden /ps:debug requires the interactive TUI.", "warning");
        return;
      }
      const { current, result, problem } = await inspect(args, "ps:debug");
      const address = endpoint();
      const text = boundedDisplay(
        [
          `Status: ${status()}`,
          `GARDEN_SERVER: ${address?.url ?? "(unavailable)"}`,
          `GARDEN_TOKEN: ${address?.token ?? "(unavailable)"}`,
          `Generation: ${current?.generation ?? "(no executor)"}`,
          `Executor IPC: ${current?.client.available ? "connected" : "unavailable"}`,
          `Generation cancelled: ${current?.lifetime.signal.aborted ?? false}`,
          `Pending input approvals: ${current ? [...current.approvals.values()].reduce((count, entries) => count + entries.size, 0) : 0}`,
          `Pi session: ${ctx.sessionManager.getSessionId()}`,
          `Pi cwd: ${ctx.cwd}`,
          `Node: ${process.version} (${process.execPath})`,
          `Platform: ${process.platform}/${process.arch}`,
          `IPC contract: ${CONTRACT}`,
          `Output limits (bytes): ${JSON.stringify(OUTPUT_LIMITS)}`,
          ...(problem
            ? [problem]
            : [
                `Managed processes (${result!.jobs.length}; bounded summaries):`,
                JSON.stringify(result!.jobs, null, 2),
              ]),
          ...(result?.tail ? [`Output tail (non-consuming):\n${result.tail}`] : []),
          "Snapshot only. Credentials may become stale after server loss or a generation change.",
        ].join("\n"),
        64 * 1024,
      );
      await ctx.ui.custom<void>(
        (tui, theme, keys, done) => {
          let offset = 0;
          let lastOffset = 0;
          const pageSize = () => Math.max(1, tui.terminal.rows - 5);
          return {
            render(width) {
              if (width <= 0) return [];
              const lines = wrapTextWithAnsi(text, width);
              lastOffset = Math.max(0, lines.length - pageSize());
              offset = Math.min(offset, lastOffset);
              return [
                theme.fg("accent", theme.bold("Mikoto Garden debug — snapshot")),
                theme.fg(
                  "warning",
                  "Contains bearer credentials. Do not share or record this view.",
                ),
                ...lines.slice(offset, offset + pageSize()),
                theme.fg(
                  "dim",
                  `↑↓ / PgUp / PgDn scroll · ${keyHint("tui.select.cancel", "close")}`,
                ),
              ].map((line) => truncateToWidth(line, width, ""));
            },
            invalidate() {
              /* Rewrap and restyle on the next render. */
            },
            handleInput(data) {
              if (
                keys.matches(data, "tui.select.cancel") ||
                keys.matches(data, "tui.select.confirm")
              ) {
                done();
                return;
              }
              if (keys.matches(data, "tui.select.up")) offset--;
              else if (keys.matches(data, "tui.select.down")) offset++;
              else if (keys.matches(data, "tui.select.pageUp")) offset -= pageSize();
              else if (keys.matches(data, "tui.select.pageDown")) offset += pageSize();
              offset = Math.max(0, Math.min(offset, lastOffset));
              tui.requestRender();
            },
          };
        },
        { overlay: true, overlayOptions: { width: "90%", margin: 1 } },
      );
    },
  });
  pi.registerCommand("stop", {
    description: "Stop Garden background jobs; /stop <id> or /stop all",
    async handler(args, ctx) {
      ui.setContext(ctx);
      const value = args.trim();
      if (
        value &&
        value !== "all" &&
        (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
      ) {
        throw new Error("Usage: /stop [managed-id|all]");
      }
      const current = runtime();
      if (!current) {
        ui.notify(status(), "warning");
        return;
      }
      const target = value && value !== "all" ? Number(value) : undefined;
      for (const [id, controllers] of current.approvals) {
        if (target === undefined || target === id) {
          for (const controller of controllers) controller.abort();
        }
      }
      const result = await current.client.request(
        "stop",
        target ? { id: target } : { all: value === "all" },
        15000,
      );
      ui.notify(
        result.warnings.length ? result.warnings.join("\n") : "Garden stop completed",
        result.warnings.length ? "warning" : "info",
      );
    },
  });
}
