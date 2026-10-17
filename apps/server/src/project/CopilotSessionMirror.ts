/**
 * Mirrors GitHub Copilot CLI sessions from `~/.copilot` into their projects as
 * resumable threads, so a session started in the CLI or VS Code shows up here
 * without the onboarding import. Sessions that already back a T3 provider
 * thread are skipped, including ones T3 itself started.
 */
import { ProviderDriverKind, resolveProviderInstanceEnabled } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const COPILOT_DRIVER = ProviderDriverKind.make("copilot");

const start = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const projects = yield* ProjectService.ProjectService;
  const sql = yield* SqlClient.SqlClient;

  const copilotEnabled = settings.getSettings.pipe(
    Effect.map((current) =>
      Object.values(current.providerInstances).some(
        (instance) =>
          instance.driver === COPILOT_DRIVER && resolveProviderInstanceEnabled(instance),
      ),
    ),
  );

  // The ACP Registry's Copilot agent writes to the same session store.
  const ownedSessionIds = sql<{ readonly nativeId: string | null }>`
    SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS nativeId
    FROM orchestration_v2_projection_provider_threads
    WHERE provider IN ('copilot', 'acpRegistry')
  `.pipe(
    Effect.map(
      (rows) => new Set(rows.flatMap((row) => (row.nativeId === null ? [] : [row.nativeId]))),
    ),
  );

  const sweep = Effect.gen(function* () {
    if (!(yield* copilotEnabled)) return;
    yield* scanner.refresh(["copilot"]);
    const excludeProviderSessionIds = yield* ownedSessionIds;
    for (const project of yield* projects.listShells()) {
      yield* importer
        .importRecentAgentThreads(
          { projectId: project.id },
          { sources: ["copilot"], excludeProviderSessionIds },
        )
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not mirror Copilot sessions", {
              projectId: project.id,
              cause,
            }),
          ),
        );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Copilot session mirror sweep failed", cause)),
  );

  yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced("3 minutes")), Effect.asVoid));
});

export const layer = Layer.effectDiscard(start);
