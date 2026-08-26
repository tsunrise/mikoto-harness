import { preparePatch as preparePatchNative } from "../native/index.js";

export interface PreparedPatch {
  hello: string;
}

export function preparePatch(root: string, patch: string): PreparedPatch {
  return preparePatchNative(root, patch);
}
