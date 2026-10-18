/**
 * Appends turns made in another Copilot client (the CLI, VS Code) to the T3
 * thread bound to the same session. The session's `events.jsonl` holds every
 * turn, T3's included, so the newest thread user message that also appears in
 * the log anchors what this thread already has; everything after it is foreign.
 */
import { ProviderDriverKind, type ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { importedMessageEvents } from "./AgentSessionImporter.ts";

const COPILOT_DRIVER = ProviderDriverKind.make("copilot");
const MAX_LOG_BYTES = 32 * 1024 * 1024;
// A log written this recently may be mid-turn in another client.
const QUIET_MS = 2 * 60 * 1000;
const RECENT_USER_MESSAGES = 50;

export interface CopilotLogMessage {
  readonly eventId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface ThreadUserMessage {
  readonly messageId: string;
  readonly text: string;
}

const CopilotLogRecord = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    id: Schema.optional(Schema.String),
    timestamp: Schema.optional(Schema.String),
    agentId: Schema.optional(Schema.Unknown),
    data: Schema.optional(
      Schema.Struct({
        content: Schema.optional(Schema.String),
        parentToolCallId: Schema.optional(Schema.Unknown),
      }),
    ),
  }),
);
const decodeCopilotLogRecord = Schema.decodeUnknownOption(CopilotLogRecord);

export function parseCopilotLogMessages(contents: string): ReadonlyArray<CopilotLogMessage> {
  const messages: Array<CopilotLogMessage> = [];
  for (const line of contents.split("\n")) {
    if (!line.includes('"user.message"') && !line.includes('"assistant.message"')) continue;
    const record = decodeCopilotLogRecord(line);
    if (Option.isNone(record)) continue;
    const { type, id, timestamp, agentId, data } = record.value;
    if (type !== "user.message" && type !== "assistant.message") continue;
    // Sub-agent records and task-tool replies belong to nested runs, not the conversation.
    if (agentId !== undefined || data?.parentToolCallId !== undefined) continue;
    const text = data?.content?.trim() ?? "";
    if (!id || !timestamp || text.length === 0) continue;
    messages.push({
      eventId: id,
      role: type === "user.message" ? "user" : "assistant",
      text,
      createdAt: timestamp,
    });
  }
  return messages;
}

export const syncedMessageSuffix = (eventId: string) => `copilot:${eventId}`;

/**
 * The log messages the thread is missing. `recentUserMessages` is newest
 * first. A message this sync wrote anchors exactly by id; any other user
 * message anchors by text, and the rest of its turn is assumed present.
 */
export function planForeignMessages(input: {
  readonly threadId: ThreadId;
  readonly log: ReadonlyArray<CopilotLogMessage>;
  readonly recentUserMessages: ReadonlyArray<ThreadUserMessage>;
}): ReadonlyArray<CopilotLogMessage> {
  const syncedPrefix = `${input.threadId}:copilot:`;
  for (const message of input.recentUserMessages) {
    let anchor = -1;
    if (message.messageId.startsWith(syncedPrefix)) {
      const eventId = message.messageId.slice(syncedPrefix.length);
      anchor = input.log.findIndex((entry) => entry.eventId === eventId);
      if (anchor === -1) continue;
      return input.log.slice(anchor + 1);
    }
    const text = message.text.trim();
    anchor = input.log.findLastIndex((entry) => entry.role === "user" && entry.text === text);
    // Prompts sent with attachments carry their paths after the typed text.
    if (anchor === -1 && text.length > 0) {
      anchor = input.log.findLastIndex(
        (entry) => entry.role === "user" && entry.text.startsWith(text),
      );
    }
    if (anchor === -1) continue;
    const nextUser = input.log.findIndex((entry, index) => index > anchor && entry.role === "user");
    return nextUser === -1 ? [] : input.log.slice(nextUser);
  }
  return [];
}

interface CopilotThreadRow {
  readonly threadId: ThreadId;
  readonly sessionId: string | null;
  readonly instanceId: ProviderInstanceId | null;
}

const start = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const eventSink = yield* EventSink.EventSinkV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const hostEnvironment = yield* HostProcess.Environment;
  const homeDir = yield* HostProcess.HomeDirectory;
  const seenLogs = new Map<ThreadId, string>();

  const copilotHome = (instanceId: ProviderInstanceId) =>
    settings.getSettings.pipe(
      Effect.map((current) => {
        const configured =
          current.providerInstances[instanceId]?.environment?.findLast(
            (variable) => variable.name === "COPILOT_HOME",
          )?.value ?? hostEnvironment.COPILOT_HOME;
        const trimmed = configured?.trim();
        if (!trimmed) return path.join(homeDir, ".copilot");
        return path.resolve(
          trimmed.startsWith("~/") ? path.join(homeDir, trimmed.slice(2)) : trimmed,
        );
      }),
    );

  const syncThread = Effect.fn("CopilotTranscriptSync.syncThread")(function* (
    row: CopilotThreadRow & { readonly sessionId: string; readonly instanceId: ProviderInstanceId },
    nowMs: number,
  ) {
    const logPath = path.join(
      yield* copilotHome(row.instanceId),
      "session-state",
      row.sessionId,
      "events.jsonl",
    );
    const info = yield* fileSystem.stat(logPath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return;
    const size = Number(info.value.size);
    const mtimeMs = Option.getOrElse(
      Option.map(info.value.mtime, (date) => date.getTime()),
      () => 0,
    );
    if (size > MAX_LOG_BYTES || nowMs - mtimeMs < QUIET_MS) return;
    const fingerprint = `${size}:${mtimeMs}`;
    if (seenLogs.get(row.threadId) === fingerprint) return;

    const log = parseCopilotLogMessages(yield* fileSystem.readFileString(logPath));
    const recentUserMessages = yield* sql<ThreadUserMessage>`
      SELECT message_id AS messageId, json_extract(payload_json, '$.text') AS text
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ${row.threadId} AND role = 'user'
      ORDER BY created_at DESC, message_id DESC
      LIMIT ${RECENT_USER_MESSAGES}
    `;
    const planned = planForeignMessages({ threadId: row.threadId, log, recentUserMessages });
    const existing =
      planned.length === 0
        ? new Set<string>()
        : new Set(
            (yield* sql<{ readonly messageId: string }>`
              SELECT message_id AS messageId FROM orchestration_v2_projection_messages
              WHERE thread_id = ${row.threadId}
                AND message_id IN ${sql.in(
                  planned.map(
                    (message) => `${row.threadId}:${syncedMessageSuffix(message.eventId)}`,
                  ),
                )}
            `).map((entry) => entry.messageId),
          );
    const missing = planned.filter(
      (message) => !existing.has(`${row.threadId}:${syncedMessageSuffix(message.eventId)}`),
    );
    if (missing.length > 0) {
      const [next] = yield* sql<{ readonly ordinal: number | null }>`
        SELECT MAX(ordinal) AS ordinal FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${row.threadId}
      `;
      const firstOrdinal = (next?.ordinal ?? 0) + 1;
      yield* eventSink.write({
        events: missing.flatMap((message, index) =>
          importedMessageEvents({
            threadId: row.threadId,
            suffix: syncedMessageSuffix(message.eventId),
            ordinal: firstOrdinal + index,
            message,
          }),
        ),
      });
      yield* Effect.logInfo("Synced Copilot turns from another client", {
        threadId: row.threadId,
        messages: missing.length,
      });
    }
    seenLogs.set(row.threadId, fingerprint);
  });

  const sweep = Effect.gen(function* () {
    // Threads with a live run are skipped: T3 itself is writing their log.
    const rows = yield* sql<CopilotThreadRow>`
      SELECT
        t.thread_id AS threadId,
        json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS sessionId,
        json_extract(pt.payload_json, '$.providerInstanceId') AS instanceId
      FROM orchestration_v2_projection_threads t
      JOIN orchestration_v2_projection_provider_threads pt
        ON pt.provider_thread_id = t.active_provider_thread_id
      WHERE pt.provider = ${COPILOT_DRIVER}
        AND t.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs r
          WHERE r.thread_id = t.thread_id
            AND r.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
        )
    `;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    for (const row of rows) {
      const { sessionId, instanceId } = row;
      if (sessionId === null || instanceId === null) continue;
      yield* syncThread({ ...row, sessionId, instanceId }, nowMs).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not sync a Copilot thread", { threadId: row.threadId, cause }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Copilot transcript sync sweep failed", cause)),
  );

  yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid));
});

export const layer = Layer.effectDiscard(start);
