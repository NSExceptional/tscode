/**
 * Scoped Effect wrapper around `@github/copilot-sdk`'s `CopilotClient`, which
 * spawns the installed `copilot` binary and drives it over stdio JSON-RPC.
 */
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type GetAuthStatusResponse,
  type ModelInfo,
  type ResumeSessionConfig,
  type SessionConfig,
} from "@github/copilot-sdk";
// Binary resolution runs inside the SDK spawn callback, outside any Effect context.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export class CopilotSdkError extends Schema.TaggedError<CopilotSdkError>()("CopilotSdkError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `GitHub Copilot SDK operation '${this.operation}' failed.`;
  }
}

const toSdkError =
  (operation: string) =>
  (cause: unknown): CopilotSdkError =>
    new CopilotSdkError({ operation, cause });

function toStringEnv(
  environment: NodeJS.ProcessEnv | undefined,
): Record<string, string> | undefined {
  if (!environment) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    // A directory named `copilot` earlier in PATH must not shadow the real CLI.
    const stat = await NodeFS.promises.stat(candidate);
    if (!stat.isFile()) return false;
    await NodeFS.promises.access(candidate, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The SDK does not resolve a bare command against PATH, and a GUI-launched app
 * inherits a minimal PATH, so resolve `copilot` ourselves. Paths containing a
 * separator are used verbatim; an unresolved name falls through so the SDK
 * reports its own diagnostic.
 */
export async function resolveCopilotBinaryPath(
  binary: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
): Promise<string> {
  if (binary.includes(NodePath.sep) || binary.includes("/")) return binary;

  const home = env?.HOME ?? process.env.HOME ?? "";
  const pathValue = env?.PATH ?? process.env.PATH ?? "";
  // An empty POSIX PATH component means the current directory.
  const pathDirs = pathValue
    .split(NodePath.delimiter)
    .map((d) => (d === "" ? NodePath.resolve(".") : d.trim()))
    .filter(Boolean);

  // npm installs `copilot.cmd` on Windows, so probe each PATHEXT suffix too.
  const isWindows = NodePath.sep === "\\";
  const pathext = isWindows
    ? (env?.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((ext) => ext.trim())
        .filter(Boolean)
    : [];
  const candidateNames = [
    binary,
    ...pathext
      .filter((ext) => !binary.toLowerCase().endsWith(ext.toLowerCase()))
      .map((ext) => `${binary}${ext}`),
  ];
  const commonDirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    ...(home
      ? [
          NodePath.join(home, ".local/bin"),
          NodePath.join(home, ".bun/bin"),
          NodePath.join(home, ".volta/bin"),
          NodePath.join(home, ".npm-global/bin"),
        ]
      : []),
  ];

  const seen = new Set<string>();
  for (const dir of [...pathDirs, ...commonDirs]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    for (const name of candidateNames) {
      const candidate = NodePath.join(dir, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return binary;
}

// `start()` runs inside acquireRelease's uninterruptible acquire, so an outer
// Effect.timeout cannot cut a stalled handshake; bound it at the JS level.
const CLIENT_START_TIMEOUT_MS = 15_000;
// The SDK's `stop()` resolves (not rejects) when its own shutdown budget runs
// out, so only racing our own timer catches a hang.
const CLIENT_STOP_TIMEOUT_MS = 2_000;

const TIMED_OUT = Symbol("timed-out");

async function startClientWithTimeout(client: CopilotClient, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // @effect-diagnostics-next-line globalTimers:off
    timer = setTimeout(
      () => reject(new Error(`Copilot runtime did not start within ${timeoutMs}ms.`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    await Promise.race([client.start(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopClientBounded(client: CopilotClient, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    // @effect-diagnostics-next-line globalTimers:off
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      client.stop().then(
        () => "done" as const,
        () => "done" as const,
      ),
      timeout,
    ]);
    if (outcome === TIMED_OUT) {
      await client.forceStop().catch(() => {});
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface CopilotSdkClient {
  readonly raw: CopilotClient;
  readonly listModels: Effect.Effect<ReadonlyArray<ModelInfo>, CopilotSdkError>;
  readonly getAuthStatus: Effect.Effect<GetAuthStatusResponse, CopilotSdkError>;
  readonly createSession: (config: SessionConfig) => Effect.Effect<CopilotSession, CopilotSdkError>;
  readonly resumeSession: (
    sessionId: string,
    config: ResumeSessionConfig,
  ) => Effect.Effect<CopilotSession, CopilotSdkError>;
}

export interface CopilotSdkClientInput {
  readonly binaryPath?: string | null;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly startTimeoutMs?: number;
}

/** A started client, stopped when the enclosing scope closes. */
export const makeCopilotSdkClient = (
  input: CopilotSdkClientInput,
): Effect.Effect<CopilotSdkClient, CopilotSdkError, Scope.Scope> => {
  const env = toStringEnv(input.environment);
  const binary = input.binaryPath?.trim() || "copilot";

  const acquire = Effect.tryPromise({
    try: async () => {
      const path = await resolveCopilotBinaryPath(binary, env);
      const client = new CopilotClient({
        // The SDK rejects env at both client and connection level; stdio prefers the connection.
        connection: RuntimeConnection.forStdio({ path, ...(env ? { env } : {}) }),
        ...(input.cwd ? { workingDirectory: input.cwd } : {}),
      });
      // A rejected start never reaches acquireRelease's release, so stop it here.
      try {
        await startClientWithTimeout(client, input.startTimeoutMs ?? CLIENT_START_TIMEOUT_MS);
      } catch (error) {
        await stopClientBounded(client, CLIENT_STOP_TIMEOUT_MS);
        throw error;
      }
      return client;
    },
    catch: toSdkError("start"),
  });

  const release = (client: CopilotClient) =>
    Effect.promise(() => stopClientBounded(client, CLIENT_STOP_TIMEOUT_MS)).pipe(Effect.asVoid);

  return Effect.acquireRelease(acquire, release).pipe(
    Effect.map((client): CopilotSdkClient => ({
      raw: client,
      listModels: Effect.tryPromise({
        try: () => client.listModels(),
        catch: toSdkError("listModels"),
      }),
      getAuthStatus: Effect.tryPromise({
        try: () => client.getAuthStatus(),
        catch: toSdkError("getAuthStatus"),
      }),
      createSession: (config) =>
        Effect.tryPromise({
          try: () => client.createSession(config),
          catch: toSdkError("createSession"),
        }),
      resumeSession: (sessionId, config) =>
        Effect.tryPromise({
          try: () => client.resumeSession(sessionId, config),
          catch: toSdkError("resumeSession"),
        }),
    })),
  );
};
