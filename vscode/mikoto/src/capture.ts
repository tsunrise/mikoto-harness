import type * as vscode from "vscode";
import { TEXT_BYTES, truncateUtf8, validPath, type Snapshot } from "./protocol";

export type EditorAPI = Pick<typeof vscode, "window" | "workspace" | "Range">;

export function captureEditor(
  editor: vscode.TextEditor,
  workspacePath: string,
  Range: typeof vscode.Range,
): Snapshot {
  const document = editor.document;
  const snapshot: Snapshot = {
    filePath: document.uri.fsPath,
    workspacePath,
    selections: [],
    truncated: editor.selections.length > 32,
  };
  let remaining = TEXT_BYTES;
  for (const selection of editor.selections.slice(0, 32)) {
    const { start, end } = selection;
    let offset = document.offsetAt(start);
    const endOffset = document.offsetAt(end);
    let text = "";
    let carry = "";
    while (offset < endOffset && remaining > 0) {
      const next = Math.min(offset + 2048, endOffset);
      let chunk = carry + document.getText(new Range(document.positionAt(offset), document.positionAt(next)));
      carry = "";
      if (next < endOffset && /[\uD800-\uDBFF]$/.test(chunk)) {
        carry = chunk.slice(-1);
        chunk = chunk.slice(0, -1);
      }
      const prefix = truncateUtf8(chunk, remaining);
      text += prefix;
      remaining -= Buffer.byteLength(prefix);
      offset = next;
      if (prefix.length !== chunk.length) {
        snapshot.truncated = true;
        break;
      }
    }
    // A pending surrogate belongs to text we didn't transmit, including when
    // the previous chunk used the last byte of the shared budget.
    if (offset < endOffset || carry) snapshot.truncated = true;
    snapshot.selections.push({
      start: { line: start.line, character: start.character },
      end: { line: end.line, character: end.character },
      text,
    });
  }
  return snapshot;
}

export function createCapture(api: EditorAPI) {
  const eligible = (editor: vscode.TextEditor | undefined) => {
    if (!editor || editor.document.isClosed || editor.document.uri.scheme !== "file") return;
    const folder = api.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder?.uri.scheme !== "file" || !validPath(folder.uri.fsPath) ||
      !validPath(editor.document.uri.fsPath)) return;
    return folder.uri.fsPath;
  };
  let remembered = eligible(api.window.activeTextEditor) ? api.window.activeTextEditor : undefined;
  const prune = () => {
    if (remembered && (!api.window.visibleTextEditors.includes(remembered) || !eligible(remembered))) {
      remembered = undefined;
    }
  };
  const subscriptions = [
    api.window.onDidChangeActiveTextEditor(editor => {
      if (editor) remembered = eligible(editor) ? editor : undefined;
      prune();
    }),
    api.window.onDidChangeVisibleTextEditors(prune),
    api.workspace.onDidCloseTextDocument(prune),
  ];
  return {
    capture(): Snapshot | undefined {
      prune();
      const current = api.window.activeTextEditor;
      if (current) remembered = eligible(current) ? current : undefined;
      const editor = current ?? remembered;
      const folder = eligible(editor);
      if (!editor || !folder || editor.selections.length === 0) return;
      return captureEditor(editor, folder, api.Range);
    },
    dispose() {
      remembered = undefined;
      subscriptions.forEach(subscription => subscription.dispose());
    },
  };
}
