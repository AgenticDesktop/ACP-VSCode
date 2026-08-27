/**
 * Pure (vscode-free) mapping from ACP `ModelInfo` entries (the UNSTABLE
 * `models` field of `session/new` / `session/load` responses) to the plain
 * data shape expected by {@link AcpLanguageModelProvider}.
 *
 * Kept in its own module so tests can run under plain `node --test` without
 * importing the `vscode` module.
 */

/** Minimal subset of the ACP `ModelInfo` schema needed for the picker. */
export interface AcpModelInput {
  readonly modelId: string;
  readonly name: string;
  readonly description?: string | null;
}

/**
 * Pure data form of a `vscode.LanguageModelChatInformation` entry contributed
 * for an ACP agent model (plus the picker-relevant extra fields).
 */
export interface AcpModelShape {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly version: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly capabilities: { readonly toolCalling: boolean };
  readonly tooltip?: string;
  readonly isUserSelectable: true;
  readonly targetChatSessionType: string;
}

const DEFAULT_MAX_INPUT_TOKENS = 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;

/**
 * Maps ACP model entries to language-model picker entries for the given slot.
 * Entries with an empty `modelId` are dropped and duplicate `modelId`s are
 * resolved by keeping the first occurrence.
 */
export function mapAcpModelsToInfo(slot: string, models: readonly AcpModelInput[]): AcpModelShape[] {
  const family = `acp-${slot}`;
  const result: AcpModelShape[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const modelId = typeof model?.modelId === "string" ? model.modelId : "";
    if (modelId.length === 0 || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    const name = typeof model?.name === "string" && model.name.length > 0 ? model.name : modelId;
    const description =
      typeof model?.description === "string" && model.description.length > 0
        ? model.description
        : undefined;
    result.push({
      id: modelId,
      name,
      family,
      version: "default",
      maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: { toolCalling: true },
      tooltip: description,
      isUserSelectable: true,
      targetChatSessionType: family,
    });
  }
  return result;
}
