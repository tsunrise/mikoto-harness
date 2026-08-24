import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BUNDLED_POLICY_PATH,
  MikotoPolicyConfig,
  MikotoPolicyDocumentLoader,
} from "./config.ts";
import { enforcePiNativeTools } from "./built-in-tools.ts";
import { provideExtensionsApi } from "./extensions-api.ts";
import { registerViewConfigCommand } from "./command.ts";

export default async function mikotoPolicy(pi: ExtensionAPI): Promise<void> {
  const bundledConfig = MikotoPolicyConfig.parse(
    JSON.parse(await readFile(BUNDLED_POLICY_PATH, "utf8")),
  );
  const loader = new MikotoPolicyDocumentLoader(bundledConfig);
  enforcePiNativeTools(loader, pi);
  provideExtensionsApi(loader, pi);
  registerViewConfigCommand(loader, pi);
}

export {
  BUNDLED_POLICY_PATH,
  mergePolicyConfigs,
  MikotoPolicyConfig,
  MikotoPolicyDocumentLoader,
  PERMISSION_PATH,
} from "./config.ts";
export type { MikotoPolicyLoadResult } from "./config.ts";
export { resolveToolPath } from "./utils.ts";

export type { MikotoPolicyDocument } from "mikoto-types";
