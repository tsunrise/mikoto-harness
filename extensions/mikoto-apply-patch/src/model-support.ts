import type { Model } from "@earendil-works/pi-ai";

const RAW_OPENAI_GRAMMAR_APIS = new Set([
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "openai-completions",
]);

export function supportsApplyPatch(
  model: Model<any> | undefined,
): boolean {
  const compat =
    model?.compat as
      | { supportsOpenAIGrammarTools?: boolean }
      | undefined;
  return (
    model !== undefined &&
    RAW_OPENAI_GRAMMAR_APIS.has(model.api) &&
    compat?.supportsOpenAIGrammarTools === true
  );
}
