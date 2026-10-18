import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as VsCodeChatSessionStore from "./VsCodeChatSessionStore.ts";

const STATE_CACHE_KEY = "agentSessions.state.cache";

const makeStateDb = Effect.fn("makeStateDb")(function* (entries: ReadonlyArray<unknown>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "vscdb-" });
  const dbPath = path.join(directory, "state.vscdb");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    STATE_CACHE_KEY,
    JSON.stringify(entries),
  );
  db.close();
  return dbPath;
});

const readStateCache = (dbPath: string): Array<Record<string, unknown>> => {
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(STATE_CACHE_KEY) as
    | { readonly value: string }
    | undefined;
  db.close();
  return row ? JSON.parse(row.value) : [];
};

const session = (id: string, archived?: boolean) => ({
  resource: `copilotcli:/${id}`,
  read: 1,
  ...(archived === undefined ? {} : { archived }),
});

it.layer(NodeServices.layer)("VsCodeChatSessionStore", (it) => {
  it.effect("reads only Copilot CLI sessions marked done", () =>
    Effect.gen(function* () {
      const dbPath = yield* makeStateDb([
        session("A"),
        session("B", true),
        session("C", false),
        { resource: "claude-code:/D", archived: true },
      ]);
      expect([...(yield* VsCodeChatSessionStore.readArchivedCopilotSessionIds(dbPath))]).toEqual([
        "B",
      ]);
      expect(
        (yield* VsCodeChatSessionStore.readArchivedCopilotSessionIds("/no/such/state.vscdb")).size,
      ).toBe(0);
    }),
  );

  it.effect("marks sessions done without touching other entries", () =>
    Effect.gen(function* () {
      const dbPath = yield* makeStateDb([
        session("A"),
        session("B", true),
        { resource: "claude-code:/C", archived: true, extra: "keep" },
      ]);
      expect(
        yield* VsCodeChatSessionStore.writeArchivedCopilotSessions(dbPath, ["A", "B", "D"], 42),
      ).toBe(2);
      expect(readStateCache(dbPath)).toEqual([
        { resource: "copilotcli:/A", read: 1, archived: true },
        { resource: "copilotcli:/B", read: 1, archived: true },
        { resource: "claude-code:/C", archived: true, extra: "keep" },
        { resource: "copilotcli:/D", archived: true, read: 42 },
      ]);
      expect(yield* VsCodeChatSessionStore.writeArchivedCopilotSessions(dbPath, ["A"], 43)).toBe(0);
    }),
  );

  it.effect("finds a workspace's state database by its folder URI", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "vscode-user-" });
      const workspace = path.join(userDir, "workspaceStorage", "hash");
      yield* fileSystem.makeDirectory(workspace, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(workspace, "workspace.json"),
        JSON.stringify({ folder: "file:///Users/x/my%20proj" }),
      );
      yield* fileSystem.writeFileString(path.join(workspace, "state.vscdb"), "");

      const find = (folder: string) =>
        VsCodeChatSessionStore.findWorkspaceStateDb(folder).pipe(
          Effect.provideService(HostProcess.Environment, { T3_VSCODE_USER_DIR: userDir }),
        );
      expect(yield* find("/Users/x/my proj/")).toBe(path.join(workspace, "state.vscdb"));
      expect(yield* find("/Users/x/other")).toBeNull();
    }),
  );
});
