import type { SessionConfig } from "@github/copilot-sdk";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

import type { CopilotSettings } from "../settings.ts";
import { resolveCopilotTunables } from "./models.ts";
import { makeCopilotSdkClient } from "./sdkClient.ts";

const COPILOT_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeCopilotTextGeneration = Effect.fn("makeCopilotTextGeneration")(function* (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv,
) {
  yield* Effect.void;

  const runCopilotJson: TextGenerationOperations.Runner = (request) => {
    const { operation, cwd, prompt, modelSelection } = request;
    return Effect.gen(function* () {
      const client = yield* makeCopilotSdkClient({
        binaryPath: settings.binaryPath,
        environment,
        cwd,
      });
      const tunables = resolveCopilotTunables(modelSelection);
      const session = yield* client.createSession({
        workingDirectory: cwd,
        // The prompt embeds untrusted diffs and PR bodies, so tools must never run.
        onPermissionRequest: () => ({ kind: "reject" }),
        ...(modelSelection.model ? { model: modelSelection.model } : {}),
        ...(tunables.reasoningEffort ? { reasoningEffort: tunables.reasoningEffort } : {}),
        ...(tunables.contextTier ? { contextTier: tunables.contextTier } : {}),
      } as SessionConfig);
      const text = yield* Effect.tryPromise({
        try: () =>
          session
            .sendAndWait({ prompt, agentMode: "interactive" }, COPILOT_TIMEOUT_MS)
            .then((message) => (message?.data.content ?? "").trim()),
        catch: (cause) =>
          new TextGenerationError({ operation, detail: "GitHub Copilot request failed.", cause }),
      }).pipe(Effect.ensuring(Effect.promise(() => session.disconnect().catch(() => {}))));
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail: "GitHub Copilot returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "GitHub Copilot", text);
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "GitHub Copilot text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );
  };

  return TextGenerationOperations.fromRunner(
    "CopilotTextGeneration",
    TextGenerationOperations.withoutInvestigation("GitHub Copilot", runCopilotJson),
  );
});
