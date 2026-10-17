import type { ModelInfo } from "@github/copilot-sdk";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  buildCopilotModelCapabilities,
  buildCopilotModels,
  modelSupportsLongContext,
  resolveCopilotTunables,
} from "./models.ts";

// Modeled on real `client.listModels()` output from Copilot CLI 1.0.80.
const sonnet5 = {
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  capabilities: {
    supports: { vision: true, reasoningEffort: true },
    limits: { max_context_window_tokens: 1_000_000 },
  },
  billing: { tokenPrices: { longContext: { contextMax: 936_000 } } },
  policy: { state: "enabled", terms: "" },
} as unknown as ModelInfo;

const sonnet45 = {
  id: "claude-sonnet-4.5",
  name: "Claude Sonnet 4.5",
  capabilities: {
    supports: { vision: true, reasoningEffort: false },
    limits: { max_context_window_tokens: 144_000 },
  },
  billing: { tokenPrices: {} },
  policy: { state: "enabled", terms: "" },
} as unknown as ModelInfo;

const disabledModel = {
  id: "legacy-model",
  name: "Legacy",
  capabilities: {
    supports: { vision: false, reasoningEffort: false },
    limits: { max_context_window_tokens: 0 },
  },
  policy: { state: "disabled", terms: "" },
} as unknown as ModelInfo;

const selection = (options: ModelSelection["options"]): ModelSelection => ({
  instanceId: ProviderInstanceId.make("copilot"),
  model: "claude-sonnet-5",
  ...(options ? { options } : {}),
});

describe("buildCopilotModelCapabilities", () => {
  it("offers long context only with a longContext billing tier", () => {
    expect(modelSupportsLongContext(sonnet5)).toBe(true);
    expect(modelSupportsLongContext(sonnet45)).toBe(false);
  });

  it("surfaces reasoning effort and context window for a model that supports both", () => {
    const descriptors = buildCopilotModelCapabilities(sonnet5).optionDescriptors ?? [];
    expect(descriptors.map((d) => d.id)).toEqual(["reasoningEffort", "contextTier"]);
    const effort = descriptors[0];
    expect(effort?.type === "select" ? effort.options.map((o) => o.id) : []).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("surfaces nothing for a model with neither lever", () => {
    expect(buildCopilotModelCapabilities(sonnet45).optionDescriptors ?? []).toEqual([]);
  });
});

describe("buildCopilotModels", () => {
  it("skips disabled models and dedupes by id", () => {
    expect(
      buildCopilotModels([sonnet5, sonnet45, disabledModel, sonnet5]).map((m) => m.slug),
    ).toEqual(["claude-sonnet-5", "claude-sonnet-4.5"]);
    expect(buildCopilotModels(undefined)).toEqual([]);
  });
});

describe("resolveCopilotTunables", () => {
  it("extracts reasoning effort and context tier", () => {
    expect(
      resolveCopilotTunables(
        selection([
          { id: "reasoningEffort", value: "high" },
          { id: "contextTier", value: "long_context" },
        ]),
      ),
    ).toEqual({ reasoningEffort: "high", contextTier: "long_context" });
  });

  it("reads selections stored under the fork's earlier option ids", () => {
    expect(
      resolveCopilotTunables(
        selection([
          { id: "reasoning_effort", value: "none" },
          { id: "context_tier", value: "default" },
        ]),
      ),
    ).toEqual({ reasoningEffort: "none", contextTier: "default" });
  });

  it("drops unknown and invalid values", () => {
    expect(
      resolveCopilotTunables(
        selection([
          { id: "contextTier", value: "gigantic" },
          { id: "reasoningEffort", value: true },
        ]),
      ),
    ).toEqual({});
    expect(resolveCopilotTunables(undefined)).toEqual({});
  });
});
