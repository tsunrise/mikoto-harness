import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BUNDLED_POLICY_PATH,
  MikotoPolicyConfig,
} from "./config.ts";
import { enforcePiNativeTools } from "./native.ts";


export default async function mikotoPolicy(pi: ExtensionAPI): Promise<void> {
  const policy = MikotoPolicyConfig.parse(JSON.parse(await readFile(BUNDLED_POLICY_PATH, "utf8")));
  enforcePiNativeTools(policy, pi)
}

export {
  BUNDLED_POLICY_PATH,
  mergePolicyConfigs,
  MikotoPolicyConfig,
} from "./config.ts";

export type { MikotoPolicyDocument } from "mikoto-types";
