import type * as vscode from "vscode";
import type { EditorAPI } from "../src/capture";

export class Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
  constructor(start: Range["start"], end: Range["end"]) {
    [this.start, this.end] = start.line < end.line || (start.line === end.line && start.character <= end.character)
      ? [start, end] : [end, start];
  }
}

export function editor(text = "unsaved text", filePath = "/workspace/file.ts") {
  const reads: number[] = [];
  const document = {
    uri: { scheme: "file", fsPath: filePath },
    isClosed: false,
    offsetAt: (p: { character: number }) => p.character,
    positionAt: (offset: number) => ({ line: 0, character: offset }),
    getText: (range: Range) => {
      reads.push(range.end.character - range.start.character);
      return text.slice(range.start.character, range.end.character);
    },
  };
  const value = {
    document,
    selections: [new Range({ line: 0, character: 0 }, { line: 0, character: text.length })],
  };
  return { value, reads, typed: value as unknown as vscode.TextEditor };
}

export function fakeAPI(initial = editor()) {
  const active = new Set<(value: unknown) => void>();
  const visible = new Set<() => void>();
  const closed = new Set<() => void>();
  function event<T>(listeners: Set<(value: T) => void>) {
    return (callback: (value: T) => void) => {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    };
  }
  const api = {
    Range,
    env: { remoteName: undefined as string | undefined },
    window: {
      activeTextEditor: initial.value as typeof initial.value | undefined,
      visibleTextEditors: [initial.value],
      onDidChangeActiveTextEditor: event(active),
      onDidChangeVisibleTextEditors: event(visible),
    },
    workspace: {
      isTrusted: true,
      getWorkspaceFolder: (uri: { fsPath: string }) =>
        uri.fsPath.startsWith("/workspace/") ? { uri: { scheme: "file", fsPath: "/workspace" } } : undefined,
      onDidCloseTextDocument: event(closed),
    },
  };
  return {
    api,
    typed: api as unknown as EditorAPI & Pick<typeof vscode, "env">,
    change(value: typeof initial.value | undefined) {
      api.window.activeTextEditor = value;
      for (const callback of active) callback(value);
    },
    hide() {
      api.window.visibleTextEditors = [];
      for (const callback of visible) callback();
    },
    close() {
      initial.value.document.isClosed = true;
      for (const callback of closed) callback();
    },
    listeners: () => active.size + visible.size + closed.size,
  };
}
