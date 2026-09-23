import * as vscode from "vscode";
import { startIntegration } from "./lifecycle";

let activation: ReturnType<typeof startIntegration> | undefined;

export async function activate(context: vscode.ExtensionContext) {
  activation = startIntegration(vscode, context);
  await activation;
}

export async function deactivate() {
  await (await activation)?.dispose();
  activation = undefined;
}
