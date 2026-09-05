import type {
  PatchPreview,
  PatchPreviewFile,
  PatchPreviewKind,
} from "./types.ts";

const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_PATCH = "*** End Patch";

const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_PREVIEW_FILES = 500;
const MAX_PREVIEW_LINES = 10_000;
const MAX_PREVIEW_LINE_CHARS = 4_096;

export function scanPatchPreview(input: string): PatchPreview {
  const prefix = input.slice(0, MAX_PREVIEW_BYTES + 1);
  const prefixBytes = Buffer.from(prefix);
  const cappedBytes = prefixBytes.subarray(
    0,
    Math.min(prefixBytes.length, MAX_PREVIEW_BYTES),
  );
  const capped = cappedBytes.toString("utf8");
  let truncated =
    input.length > prefix.length ||
    prefixBytes.length > cappedBytes.length;

  const files: PatchPreviewFile[] = [];
  const filesByPath = new Map<string, PatchPreviewFile>();
  let current: PatchPreviewFile | undefined;

  const lines = capped.split("\n");
  const lineCount = Math.min(lines.length, MAX_PREVIEW_LINES);
  if (lines.length > lineCount) truncated = true;

  for (let index = 0; index < lineCount; index++) {
    const rawLine = lines[index]?.replace(/\r$/, "") ?? "";
    if (rawLine === END_PATCH) break;

    const line =
      rawLine.length > MAX_PREVIEW_LINE_CHARS
        ? rawLine.slice(0, MAX_PREVIEW_LINE_CHARS)
        : rawLine;
    if (line.length !== rawLine.length) truncated = true;

    if (line.startsWith(MOVE_TO)) {
      if (current?.kind === "update") {
        current.movePath = line.slice(MOVE_TO.length).trim();
      }
      continue;
    }

    const header = readFileHeader(line);
    if (header) {
      const existing = filesByPath.get(header.path);
      if (existing) {
        current = existing;
        continue;
      }
      if (files.length >= MAX_PREVIEW_FILES) {
        truncated = true;
        break;
      }

      current = {
        kind: header.kind,
        path: header.path,
        additions: 0,
        deletions: 0,
      };
      files.push(current);
      filesByPath.set(header.path, current);
      continue;
    }

    if (!current || current.kind === "delete") continue;
    if (line.startsWith("+")) {
      current.additions++;
    } else if (line.startsWith("-")) {
      current.deletions++;
    }
  }

  return { files, truncated };
}

function readFileHeader(
  line: string,
): { kind: PatchPreviewKind; path: string } | undefined {
  if (line.startsWith(ADD_FILE)) {
    return header("add", line.slice(ADD_FILE.length));
  }
  if (line.startsWith(DELETE_FILE)) {
    return header("delete", line.slice(DELETE_FILE.length));
  }
  if (line.startsWith(UPDATE_FILE)) {
    return header("update", line.slice(UPDATE_FILE.length));
  }
  return undefined;
}

function header(
  kind: PatchPreviewKind,
  rawPath: string,
): { kind: PatchPreviewKind; path: string } | undefined {
  const path = rawPath.trim();
  return path ? { kind, path } : undefined;
}
