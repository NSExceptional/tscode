/**
 * Reads and writes VS Code's private "done" (archived) flag for Copilot CLI
 * sessions. VS Code keeps it in each workspace's
 * `workspaceStorage/<hash>/state.vscdb`, under the `agentSessions.state.cache`
 * memento, as `{ resource: "copilotcli:/<sessionId>", archived?: boolean }`.
 * The store is reverse engineered, so every failure degrades to "nothing".
 * VS Code rewrites the memento from memory while the workspace is open, so a
 * write only shows up the next time VS Code opens that folder.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const STATE_CACHE_KEY = "agentSessions.state.cache";
const COPILOT_RESOURCE_PREFIX = "copilotcli:/";

const decodeWorkspaceJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ folder: Schema.optional(Schema.String) })),
);
const StateCacheJson = Schema.fromJsonString(
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeStateCache = Schema.decodeUnknownOption(StateCacheJson);
const encodeStateCache = Schema.encodeSync(StateCacheJson);

type StateEntry = Record<string, unknown>;

const copilotSessionIdOf = (entry: StateEntry): string | null => {
  const resource = entry.resource;
  if (typeof resource !== "string" || !resource.startsWith(COPILOT_RESOURCE_PREFIX)) return null;
  const id = resource.slice(COPILOT_RESOURCE_PREFIX.length);
  return id.length > 0 ? id : null;
};

const trimTrailingSlash = (value: string) =>
  value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;

export const resolveVsCodeUserDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const override = environment.T3_VSCODE_USER_DIR?.trim();
  if (override) return override;
  switch (yield* HostProcess.Platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Code", "User");
    case "win32":
      return environment.APPDATA ? path.join(environment.APPDATA, "Code", "User") : null;
    default:
      return path.join(
        environment.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"),
        "Code",
        "User",
      );
  }
});

/** The `state.vscdb` of the VS Code workspace opened at `folderPath`, if any. */
export const findWorkspaceStateDb = Effect.fn("VsCodeChatSessionStore.findWorkspaceStateDb")(
  function* (folderPath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const userDir = yield* resolveVsCodeUserDir;
    if (userDir === null) return null;
    const target = `file://${trimTrailingSlash(folderPath.trim())}`;
    const storageRoot = path.join(userDir, "workspaceStorage");
    const hashes = yield* fileSystem
      .readDirectory(storageRoot)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const hash of hashes) {
      const directory = path.join(storageRoot, hash);
      const workspace = yield* fileSystem
        .readFileString(path.join(directory, "workspace.json"))
        .pipe(Effect.map(decodeWorkspaceJson), Effect.orElseSucceed(Option.none));
      const folder = Option.isSome(workspace) ? workspace.value.folder : undefined;
      if (folder === undefined) continue;
      const decoded = yield* Effect.try(() => decodeURI(folder)).pipe(
        Effect.orElseSucceed(() => folder),
      );
      if (trimTrailingSlash(decoded) !== target) continue;
      const dbPath = path.join(directory, "state.vscdb");
      return (yield* fileSystem.exists(dbPath).pipe(Effect.orElseSucceed(() => false)))
        ? dbPath
        : null;
    }
    return null;
  },
);

const readStateCache = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly value: string | Uint8Array }>`
    SELECT value FROM ItemTable WHERE key = ${STATE_CACHE_KEY}
  `;
  const value = rows[0]?.value;
  if (value === undefined) return [];
  const decoded = decodeStateCache(
    typeof value === "string" ? value : new TextDecoder().decode(value),
  );
  return Option.isSome(decoded) ? decoded.value.map((entry) => ({ ...entry })) : [];
});

/** Copilot CLI session ids VS Code marks done in this workspace. */
export const readArchivedCopilotSessionIds = (dbPath: string) =>
  readStateCache.pipe(
    Effect.map(
      (entries) =>
        new Set(
          entries.flatMap((entry) => {
            const id = entry.archived === true ? copilotSessionIdOf(entry) : null;
            return id === null ? [] : [id];
          }),
        ),
    ),
    Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })),
    Effect.orElseSucceed(() => new Set<string>()),
  );

/**
 * Marks each session done, adding an entry VS Code hasn't recorded yet. Never
 * clears a done flag. Returns how many sessions changed.
 */
export const writeArchivedCopilotSessions = (
  dbPath: string,
  sessionIds: ReadonlyArray<string>,
  nowMs: number,
) =>
  Effect.gen(function* () {
    const wanted = new Set(sessionIds);
    if (wanted.size === 0) return 0;
    const sql = yield* SqlClient.SqlClient;
    const entries: Array<StateEntry> = yield* readStateCache;
    let changed = 0;
    for (const entry of entries) {
      const id = copilotSessionIdOf(entry);
      if (id === null || !wanted.delete(id) || entry.archived === true) continue;
      entry.archived = true;
      changed += 1;
    }
    for (const id of wanted) {
      entries.push({ resource: `${COPILOT_RESOURCE_PREFIX}${id}`, archived: true, read: nowMs });
      changed += 1;
    }
    if (changed === 0) return 0;
    yield* sql`
      INSERT OR REPLACE INTO ItemTable (key, value)
      VALUES (${STATE_CACHE_KEY}, ${encodeStateCache(entries)})
    `;
    return changed;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
    Effect.orElseSucceed(() => 0),
  );
