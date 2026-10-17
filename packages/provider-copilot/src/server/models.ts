/**
 * The SDK's `listModels()` reports per-model reasoning-effort and context-tier
 * support, so each model gets its own tunables instead of one session-global set.
 */
import type { ModelInfo } from "@github/copilot-sdk";
import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { buildSelectOptionDescriptor } from "@t3tools/provider-core/server/snapshotProbe";

/**
 * Mirrored locally: the SDK does not export these unions by name. `none` is
 * included because the CLI advertises it for some models.
 */
export type CopilotReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type CopilotContextTier = "default" | "long_context";

export const COPILOT_REASONING_EFFORT_OPTION_ID = "reasoningEffort";
export const COPILOT_CONTEXT_TIER_OPTION_ID = "contextTier";
// Option ids the fork stored before moving to upstream's naming.
const LEGACY_REASONING_EFFORT_OPTION_ID = "reasoning_effort";
const LEGACY_CONTEXT_TIER_OPTION_ID = "context_tier";

const REASONING_EFFORT_VALUES: ReadonlyArray<CopilotReasoningEffort> = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const CONTEXT_TIER_VALUES: ReadonlyArray<CopilotContextTier> = ["default", "long_context"];

export const EMPTY_COPILOT_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

function reasoningEffortLabel(effort: string): string {
  switch (effort) {
    case "none":
      return "None";
    case "xhigh":
      return "Extra high";
    default:
      return effort.charAt(0).toUpperCase() + effort.slice(1);
  }
}

/** The SDK reports a `longContext` price block for exactly the models with that tier. */
export function modelSupportsLongContext(model: ModelInfo): boolean {
  return model.billing?.tokenPrices?.longContext !== undefined;
}

function reasoningEffortChoices(
  model: ModelInfo,
): ReadonlyArray<{ value: string; label: string; isDefault?: boolean }> {
  if (!model.capabilities?.supports?.reasoningEffort) return [];
  const seen = new Set<string>();
  const choices: Array<{ value: string; label: string; isDefault?: boolean }> = [];
  for (const effort of model.supportedReasoningEfforts ?? []) {
    const value = String(effort).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    choices.push({
      value,
      label: reasoningEffortLabel(value),
      ...(value === model.defaultReasoningEffort ? { isDefault: true } : {}),
    });
  }
  return choices;
}

export function buildCopilotModelCapabilities(model: ModelInfo): ModelCapabilities {
  const optionDescriptors: ProviderOptionDescriptor[] = [];

  const effortChoices = reasoningEffortChoices(model);
  if (effortChoices.length > 0) {
    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id: COPILOT_REASONING_EFFORT_OPTION_ID,
        label: "Reasoning Effort",
        options: effortChoices,
      }),
    );
  }

  if (modelSupportsLongContext(model)) {
    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id: COPILOT_CONTEXT_TIER_OPTION_ID,
        label: "Context Window",
        options: [
          { value: "default", label: "Default", isDefault: true },
          { value: "long_context", label: "Long context" },
        ],
        description: "Long context unlocks the model's extended window at a different price.",
      }),
    );
  }

  if (optionDescriptors.length === 0) return EMPTY_COPILOT_MODEL_CAPABILITIES;
  return createModelCapabilities({ optionDescriptors });
}

/** Models whose policy is explicitly `disabled` are skipped. */
export function buildCopilotModels(
  models: ReadonlyArray<ModelInfo> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!models || models.length === 0) return [];
  const seen = new Set<string>();
  const result: ServerProviderModel[] = [];
  for (const model of models) {
    const slug = model.id?.trim();
    if (!slug || seen.has(slug)) continue;
    if (model.policy?.state === "disabled") continue;
    seen.add(slug);
    result.push({
      slug,
      name: model.name?.trim() || slug,
      isCustom: false,
      capabilities: buildCopilotModelCapabilities(model),
    });
  }
  return result;
}

export interface CopilotSessionTunables {
  readonly reasoningEffort?: CopilotReasoningEffort;
  readonly contextTier?: CopilotContextTier;
}

/** Unknown or malformed values are dropped so the SDK never receives an invalid tunable. */
export function resolveCopilotTunables(
  selection: ModelSelection | null | undefined,
): CopilotSessionTunables {
  const effort =
    getModelSelectionStringOptionValue(selection, COPILOT_REASONING_EFFORT_OPTION_ID) ??
    getModelSelectionStringOptionValue(selection, LEGACY_REASONING_EFFORT_OPTION_ID);
  const tier =
    getModelSelectionStringOptionValue(selection, COPILOT_CONTEXT_TIER_OPTION_ID) ??
    getModelSelectionStringOptionValue(selection, LEGACY_CONTEXT_TIER_OPTION_ID);
  const reasoningEffort = REASONING_EFFORT_VALUES.find((value) => value === effort?.trim());
  const contextTier = CONTEXT_TIER_VALUES.find((value) => value === tier?.trim());
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(contextTier ? { contextTier } : {}),
  };
}
