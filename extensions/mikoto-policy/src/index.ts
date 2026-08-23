import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BUNDLED_POLICY_PATH,
  MikotoPolicyConfig,
} from "./config.ts";


export default async function mikotoPolicy(_pi: ExtensionAPI): Promise<void> {
  MikotoPolicyConfig.parse(JSON.parse(await readFile(BUNDLED_POLICY_PATH, "utf8")));
}

export {
  BUNDLED_POLICY_PATH,
  mergePolicyConfigs,
  MikotoPolicyConfig,
} from "./config.ts";

export type { MikotoPolicyDocument } from "mikoto-types";
