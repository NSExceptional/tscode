/**
 * Shared by the server driver and the client settings form, so it holds only
 * browser-safe schema code.
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const CopilotSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("copilot").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the GitHub Copilot CLI binary used by this instance.",
        providerSettingsForm: { placeholder: "copilot", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    settleSyncWithVsCode: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({
        title: "Sync settled with VS Code",
        description:
          "Settle a thread when its session is marked done in VS Code, and mark the session done when you settle it here. Experimental: VS Code only picks up changes when it next opens the folder.",
        providerSettingsForm: { control: "switch" },
      }),
    ),
  },
  {
    order: ["binaryPath", "settleSyncWithVsCode"],
  },
);
export type CopilotSettings = typeof CopilotSettings.Type;
