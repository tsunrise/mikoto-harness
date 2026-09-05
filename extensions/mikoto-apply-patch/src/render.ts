import {
  formatSize,
  keyHint,
  renderDiff,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

import type {
  ApplyPatchChange,
  ApplyPatchOutcome,
} from "./native.ts";
import { scanPatchPreview } from "./patch-preview.ts";

const CALL_FILES_COLLAPSED = 20;
const CALL_FILES_EXPANDED = 200;
const MAX_PATH_WIDTH = 240;
const MAX_RESULT_LINE_WIDTH = 500;
const RESULT_LINES_COLLAPSED = 200;
const RESULT_LINES_EXPANDED = 2_000;
const RESULT_BYTES = 50 * 1024;
const NOTICE_RESERVED_BYTES = 512;

const UNSAFE_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function renderApplyPatchCall(
  args: unknown,
  theme: Theme,
  expanded: boolean,
  showPreview = true,
): Component {
  const lines = [
    theme.fg("toolTitle", theme.bold("apply_patch")),
  ];
  if (!showPreview) return new Text(lines[0] ?? "", 0, 0);

  const patch =
    typeof (args as { patch?: unknown } | undefined)?.patch === "string"
      ? (args as { patch: string }).patch
      : "";
  const preview = scanPatchPreview(patch);
  const maxFiles = expanded
    ? CALL_FILES_EXPANDED
    : CALL_FILES_COLLAPSED;
  const visibleFiles = preview.files.slice(0, maxFiles);

  for (const file of visibleFiles) {
    const mark =
      file.kind === "add" ? "A" : file.kind === "delete" ? "D" : "M";
    const markColor =
      file.kind === "add"
        ? "toolDiffAdded"
        : file.kind === "delete"
          ? "toolDiffRemoved"
          : "warning";
    const source = formatPath(file.path);
    const path = file.movePath
      ? `${theme.fg("accent", source)} ${theme.fg("muted", "->")} ${theme.fg(
          "accent",
          formatPath(file.movePath),
        )}`
      : theme.fg("accent", source);
    const counts = formatCounts(
      file.additions,
      file.kind === "update" ? file.deletions : 0,
      theme,
    );
    lines.push(
      `${theme.fg(markColor, mark)} ${path}${counts}`,
    );
  }

  const hiddenFiles = preview.files.length - visibleFiles.length;
  if (hiddenFiles > 0) {
    lines.push(
      theme.fg(
        "muted",
        `… ${hiddenFiles} more ${plural(hiddenFiles, "file")}`,
      ),
    );
  }
  if (preview.truncated) {
    lines.push(theme.fg("muted", "… patch preview truncated"));
  }

  return new Text(lines.join("\n"), 0, 0);
}

export function renderApplyPatchResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details: ApplyPatchOutcome | undefined;
  },
  expanded: boolean,
  theme: Theme,
  isError: boolean,
): Component {
  if (isError) {
    return renderError(result.content, expanded, theme);
  }
  if (!result.details) {
    return new Container();
  }

  const rendered = formatSuccessfulResult(
    result.details,
    expanded,
    theme,
  );
  return rendered ? new Text(rendered, 0, 0) : new Container();
}

function formatSuccessfulResult(
  outcome: ApplyPatchOutcome,
  expanded: boolean,
  theme: Theme,
): string {
  const maxLines = expanded
    ? RESULT_LINES_EXPANDED
    : RESULT_LINES_COLLAPSED;
  const budget = new RenderBudget(
    Math.max(0, maxLines - 1),
    Math.max(0, RESULT_BYTES - NOTICE_RESERVED_BYTES),
  );
  const blocks: Array<{
    header: string;
    diffRows: string[];
    path: string;
  }> = [];

  let outputFull = false;
  let totalDiffLines = 0;
  let totalDiffBytes = 0;
  let visibleDiffLines = 0;
  let visibleDiffBytes = 0;
  let visibleFiles = 0;

  for (const change of outcome.changes) {
    const path = formatChangePath(change);
    const plainHeader = formatChangeHeader(change, path);
    const styledHeader = styleChangeHeader(change, path, theme);
    const sanitizedDiff = sanitizeMultiline(change.diff);
    const diffRows = splitDiffRows(sanitizedDiff);
    totalDiffLines += diffRows.length;
    totalDiffBytes += Buffer.byteLength(sanitizedDiff);

    const separator = blocks.length > 0 ? [""] : [];
    if (
      outputFull ||
      !budget.canAdd([...separator, plainHeader])
    ) {
      outputFull = true;
      continue;
    }

    budget.add(separator);
    budget.add([plainHeader]);
    visibleFiles++;

    const selectedRows: string[] = [];
    for (const row of diffRows) {
      const boundedRow = truncateToWidth(
        row,
        MAX_RESULT_LINE_WIDTH,
        "…",
      );
      if (!outputFull && budget.canAdd([boundedRow])) {
        budget.add([boundedRow]);
        selectedRows.push(boundedRow);
        visibleDiffLines++;
        visibleDiffBytes += Buffer.byteLength(boundedRow) + 1;
      } else {
        outputFull = true;
      }
    }

    blocks.push({
      header: styledHeader,
      diffRows: selectedRows,
      path,
    });
  }

  const renderedBlocks = blocks.map((block) => {
    if (block.diffRows.length === 0) return block.header;
    return `${block.header}\n${renderDiff(block.diffRows.join("\n"), {
      filePath: block.path,
    })}`;
  });

  const hiddenFiles = outcome.changes.length - visibleFiles;
  const hiddenLines = totalDiffLines - visibleDiffLines;
  const hiddenBytes = Math.max(
    0,
    totalDiffBytes - visibleDiffBytes,
  );
  if (hiddenFiles > 0 || hiddenLines > 0 || hiddenBytes > 0) {
    const hidden: string[] = [];
    if (hiddenFiles > 0) {
      hidden.push(`${hiddenFiles} ${plural(hiddenFiles, "file")}`);
    }
    if (hiddenLines > 0) {
      hidden.push(`${hiddenLines} diff ${plural(hiddenLines, "line")}`);
    }
    if (hiddenBytes > 0) {
      hidden.push(`${formatSize(hiddenBytes)} of diff text`);
    }
    const hint = expanded
      ? ""
      : `; ${keyHint("app.tools.expand", "to expand")}`;
    renderedBlocks.push(
      theme.fg("muted", `… ${hidden.join(", ")} hidden${hint}`),
    );
  }

  return renderedBlocks.join("\n\n");
}

function renderError(
  content: Array<{ type: string; text?: string }>,
  expanded: boolean,
  theme: Theme,
): Component {
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  const sanitized = sanitizeMultiline(text);
  const rows = sanitized.split("\n");
  const maxLines = expanded
    ? RESULT_LINES_EXPANDED
    : RESULT_LINES_COLLAPSED;
  const budget = new RenderBudget(
    Math.max(0, maxLines - 1),
    Math.max(0, RESULT_BYTES - NOTICE_RESERVED_BYTES),
  );
  const visible: string[] = [];

  for (const row of rows) {
    const boundedRow = truncateToWidth(
      row,
      MAX_RESULT_LINE_WIDTH,
      "…",
    );
    if (!budget.canAdd([boundedRow])) break;
    budget.add([boundedRow]);
    visible.push(theme.fg("error", boundedRow));
  }

  if (visible.length < rows.length) {
    const hidden = rows.length - visible.length;
    const hint = expanded
      ? ""
      : `; ${keyHint("app.tools.expand", "to expand")}`;
    visible.push(
      theme.fg(
        "muted",
        `… ${hidden} error ${plural(hidden, "line")} hidden${hint}`,
      ),
    );
  }
  return new Text(visible.join("\n"), 0, 0);
}

function formatChangePath(change: ApplyPatchChange): string {
  const source = formatPath(change.path);
  return change.movePath
    ? `${source} -> ${formatPath(change.movePath)}`
    : source;
}

function formatChangeHeader(
  change: ApplyPatchChange,
  path: string,
): string {
  return `${changeMark(change)} ${path}${plainCounts(change)}`;
}

function styleChangeHeader(
  change: ApplyPatchChange,
  path: string,
  theme: Theme,
): string {
  const mark = changeMark(change);
  const markColor =
    mark === "A"
      ? "toolDiffAdded"
      : mark === "D"
        ? "toolDiffRemoved"
        : "warning";
  return `${theme.fg(markColor, mark)} ${theme.fg("accent", path)}${formatCounts(
    change.additions,
    change.deletions,
    theme,
  )}`;
}

function changeMark(change: ApplyPatchChange): "A" | "M" | "D" {
  if (change.kind === "added") return "A";
  if (change.kind === "deleted") return "D";
  return "M";
}

function plainCounts(change: ApplyPatchChange): string {
  let output = "";
  if (change.additions > 0) output += ` +${change.additions}`;
  if (change.deletions > 0) output += ` -${change.deletions}`;
  return output;
}

function formatCounts(
  additions: number,
  deletions: number,
  theme: Theme,
): string {
  let output = "";
  if (additions > 0) {
    output += ` ${theme.fg("toolDiffAdded", `+${additions}`)}`;
  }
  if (deletions > 0) {
    output += ` ${theme.fg("toolDiffRemoved", `-${deletions}`)}`;
  }
  return output;
}

function sanitizeInline(text: string): string {
  return stripTerminalSequences(text)
    .replace(UNSAFE_CONTROL_CHARACTERS, "")
    .replace(/[\r\n]/g, "")
    .replace(/\t/g, "   ");
}

function sanitizeMultiline(text: string): string {
  return stripTerminalSequences(text)
    .replace(UNSAFE_CONTROL_CHARACTERS, "")
    .replace(/\t/g, "   ");
}

function formatPath(path: string): string {
  const sanitized = sanitizeInline(path);
  if (visibleWidth(sanitized) <= MAX_PATH_WIDTH) return sanitized;

  let tail = "";
  const characters = [...sanitized];
  for (let index = characters.length - 1; index >= 0; index--) {
    const candidate = `${characters[index]}${tail}`;
    if (visibleWidth(`…${candidate}`) > MAX_PATH_WIDTH) break;
    tail = candidate;
  }
  return `…${tail}`;
}

function splitDiffRows(diff: string): string[] {
  if (diff === "") return [];
  const rows = diff.split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

class RenderBudget {
  private lines = 0;
  private bytes = 0;
  private readonly maxLines: number;
  private readonly maxBytes: number;

  constructor(maxLines: number, maxBytes: number) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
  }

  canAdd(lines: readonly string[]): boolean {
    return (
      this.lines + lines.length <= this.maxLines &&
      this.bytes + byteLength(lines) <= this.maxBytes
    );
  }

  add(lines: readonly string[]): void {
    this.lines += lines.length;
    this.bytes += byteLength(lines);
  }
}

function byteLength(lines: readonly string[]): number {
  return lines.reduce(
    (total, line) => total + Buffer.byteLength(line) + 1,
    0,
  );
}
