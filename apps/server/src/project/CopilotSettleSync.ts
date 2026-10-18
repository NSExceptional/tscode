/**
 * Opt-in sync between a Copilot thread's settled state and VS Code's "done"
 * mark for the same Copilot CLI session. Settle-only in both directions: it
 * never unsettles a thread or clears a done mark.
 */
import {
  CommandId,
  ProviderDriverKind,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { CopilotSettings } from "@t3tools/provider-copilot/settings";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectService from "./ProjectService.ts";
import * as VsCodeChatSessionStore from "./VsCodeChatSessionStore.ts";

const COPILOT_DRIVER = ProviderDriverKind.make("copilot");
const decodeCopilotSettings = Schema.decodeUnknownOption(CopilotSettings);

interface CopilotThreadRow {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly updatedAt: string;
  readonly sessionId: string | null;
  readonly instanceId: ProviderInstanceId | null;
}

const start = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const enabledInstances = settings.getSettings.pipe(
    Effect.map(
      (current) =>
        new Set(
          Object.entries(current.providerInstances).flatMap(([instanceId, instance]) => {
            if (instance.driver !== COPILOT_DRIVER) return [];
            const config = decodeCopilotSettings(instance.config ?? {});
            return Option.isSome(config) && config.value.settleSyncWithVsCode ? [instanceId] : [];
          }),
        ),
    ),
    Effect.orElseSucceed(() => new Set<string>()),
  );

  const workspaceRoot = (projectId: ProjectId) =>
    projects
      .getById(projectId)
      .pipe(
        Effect.map(Option.map((project) => project.workspaceRoot)),
        Effect.orElseSucceed(Option.none),
      );

  // Session ids seen marked done on the previous pass. A thread is settled only
  // when its session newly becomes done, so continuing a thread here after
  // marking it done in VS Code doesn't settle it again on every pass.
  let previouslyArchived: ReadonlySet<string> = new Set();

  const pullArchived = Effect.gen(function* () {
    const enabled = yield* enabledInstances;
    if (enabled.size === 0) return;
    const rows = yield* sql<CopilotThreadRow>`
      SELECT
        t.thread_id AS threadId,
        t.project_id AS projectId,
        t.updated_at AS updatedAt,
        json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS sessionId,
        json_extract(pt.payload_json, '$.providerInstanceId') AS instanceId
      FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_provider_threads pt
        ON pt.provider_thread_id = t.active_provider_thread_id
      WHERE pt.provider = ${COPILOT_DRIVER}
        AND t.deleted_at IS NULL
        AND t.archived_at IS NULL
        AND json_extract(t.payload_json, '$.settledOverride') IS NULL
    `;
    const byRoot = new Map<string, Array<CopilotThreadRow & { readonly sessionId: string }>>();
    for (const row of rows) {
      if (row.sessionId === null || row.instanceId === null || !enabled.has(row.instanceId)) {
        continue;
      }
      const root = yield* workspaceRoot(row.projectId);
      if (Option.isNone(root)) continue;
      const group = byRoot.get(root.value) ?? [];
      group.push({ ...row, sessionId: row.sessionId });
      byRoot.set(root.value, group);
    }

    const archivedNow = new Set<string>();
    for (const [root, group] of byRoot) {
      const dbPath = yield* VsCodeChatSessionStore.findWorkspaceStateDb(root);
      if (dbPath === null) continue;
      const archived = yield* VsCodeChatSessionStore.readArchivedCopilotSessionIds(dbPath);
      for (const row of group) {
        if (!archived.has(row.sessionId)) continue;
        if (previouslyArchived.has(row.sessionId)) {
          archivedNow.add(row.sessionId);
          continue;
        }
        const uuid = yield* crypto.randomUUIDv4();
        const settled = yield* orchestrator
          .dispatch({
            type: "thread.auto-settle",
            commandId: CommandId.make(`server:copilot-settle-sync:${row.threadId}:${uuid}`),
            threadId: row.threadId,
            snapshotAt: DateTime.makeUnsafe(row.updatedAt),
          })
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not settle a thread marked done in VS Code", {
                threadId: row.threadId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
            ),
          );
        if (settled) archivedNow.add(row.sessionId);
      }
    }
    previouslyArchived = archivedNow;
  });

  const archiveInVsCode = (event: OrchestrationV2DomainEvent) =>
    Effect.gen(function* () {
      if (event.type !== "thread.settled") return;
      const thread = event.payload;
      if (thread.activeProviderThreadId === null) return;
      const enabled = yield* enabledInstances;
      if (enabled.size === 0) return;
      const rows = yield* sql<Pick<CopilotThreadRow, "sessionId" | "instanceId">>`
        SELECT
          json_extract(payload_json, '$.nativeThreadRef.nativeId') AS sessionId,
          json_extract(payload_json, '$.providerInstanceId') AS instanceId
        FROM orchestration_v2_projection_provider_threads
        WHERE provider_thread_id = ${thread.activeProviderThreadId}
          AND provider = ${COPILOT_DRIVER}
      `;
      const sessionId = rows[0]?.sessionId;
      const instanceId = rows[0]?.instanceId;
      if (!sessionId || !instanceId || !enabled.has(instanceId)) return;
      const root = yield* workspaceRoot(thread.projectId);
      if (Option.isNone(root)) return;
      const dbPath = yield* VsCodeChatSessionStore.findWorkspaceStateDb(root.value);
      if (dbPath === null) return;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      yield* VsCodeChatSessionStore.writeArchivedCopilotSessions(dbPath, [sessionId], nowMs);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not mark a Copilot session done in VS Code", {
          threadId: event.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, archiveInVsCode).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Copilot settle sync event stream failed", { cause }),
      ),
    ),
  );
  yield* forkParked(
    pullArchived.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Copilot settle sync sweep failed", cause)),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.asVoid,
    ),
  );
});

export const layer = Layer.effectDiscard(start);
