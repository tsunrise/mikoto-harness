import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Manager, Server } from "./manager.ts";
import { safeName } from "./errors.ts";
import { callable, compare } from "./schema.ts";

export function listing(servers: Server[], verbose: boolean): string {
  if (!servers.length) return "No MCP servers configured.";
  let cached = false;
  const rows: string[] = [];
  for (const s of [...servers].sort((a, b) => compare(a.server, b.server))) {
    const name = safeName(s.server);
    const tools = s.snapshot?.tools;
    const refreshing = s.state === "pending" && tools !== undefined;
    cached ||= refreshing;
    let row = `${name} (${tools ? tools.length : "0"} tools${tools ? "" : " loaded"}${refreshing && !verbose ? "*" : ""})`;
    if (refreshing && verbose) row += " [cached; refreshing]";
    if (s.state === "pending" && !tools) row += " [initializing]";
    if (s.state === "disabled") row += ` [disabled${tools ? "; last-known metadata" : ""}; ${s.reason}]`;
    if (s.state === "skipped") row += ` [skipped; ${s.reason}]`;
    rows.push(row);
    if (verbose && tools) for (const tool of [...tools].sort((a, b) => compare(a.name, b.name)))
      rows.push(`  ${safeName(tool.name, 1024)}${callable(tool) ? "" : " [unsupported: task-required]"}`);
  }
  if (cached && !verbose) rows.push("* cached; refresh in progress");
  return rows.join("\n");
}

export function registerCommands(pi: ExtensionAPI, current: () => Manager | undefined) {
  for (const verbose of [false, true]) pi.registerCommand(verbose ? "mcp:verbose" : "mcp", {
    description: verbose ? "List Mikoto MCP servers and every discovered tool." : "List Mikoto MCP servers and catalog counts.",
    async handler(args, ctx) {
      if (!ctx.hasUI) return;
      if (args.trim()) { ctx.ui.notify(`Usage: /${verbose ? "mcp:verbose" : "mcp"}`, "info"); return; }
      const manager = current();
      if (!manager) { ctx.ui.notify("Mikoto MCP runtime unavailable.", "warning"); return; }
      try {
        const servers = await manager.inspect();
        if (manager.lifetime.signal.aborted || current() !== manager) return;
        ctx.ui.notify(listing(servers, verbose), "info");
      } catch {
        if (!manager.lifetime.signal.aborted && current() === manager)
          ctx.ui.notify("Mikoto MCP configuration unavailable. Check configuration and reload.", "warning");
      }
    },
  });
}
