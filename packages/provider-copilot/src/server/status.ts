import type {
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";

import type { CopilotSettings } from "../settings.ts";
import { mapCopilotSlashCommands } from "./commands.ts";
import { buildCopilotModels, EMPTY_COPILOT_MODEL_CAPABILITIES } from "./models.ts";
import { makeCopilotSdkClient, resolveCopilotBinaryPath } from "./sdkClient.ts";
import { parseCopilotSkillsCliOutput } from "./skills.ts";

const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot (SDK)",
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "full-access"],
  reportsContextWindow: true,
  requiresNewThreadForModelChange: false,
} as const;

const VERSION_TIMEOUT_MS = 8_000;
const DISCOVERY_TIMEOUT_MS = 15_000;
// Below DISCOVERY_TIMEOUT_MS so a stalled SDK start plus its bounded stop still fits.
const DISCOVERY_START_TIMEOUT_MS = 10_000;
const SKILLS_TIMEOUT_MS = 10_000;

const EMPTY_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const EMPTY_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [];

/** Parses `copilot version`, e.g. `GitHub Copilot CLI 1.0.45`. */
export function parseCopilotVersion(output: string): string | null {
  return output.match(/GitHub Copilot CLI\s+(\d+\.\d+\.\d+)/i)?.[1] ?? null;
}

/** The CLI reads these in order; a blank higher-priority value must not mask a later one. */
export function detectCopilotAuthFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ServerProviderAuth {
  const token = [
    environment.COPILOT_GITHUB_TOKEN,
    environment.GH_TOKEN,
    environment.GITHUB_TOKEN,
  ].find((value) => value?.trim());
  return token ? { status: "authenticated" } : { status: "unknown" };
}

function copilotModels(
  settings: CopilotSettings,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    discovered,
    settings.customModels,
    EMPTY_COPILOT_MODEL_CAPABILITIES,
  );
}

const runCopilotCommand = (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv,
  args: ReadonlyArray<string>,
  cwd?: string,
) =>
  Effect.gen(function* () {
    // A GUI-launched server has a minimal PATH; resolve the binary like the SDK client does.
    const binary = yield* Effect.promise(() =>
      resolveCopilotBinaryPath(settings.binaryPath || "copilot", environment),
    );
    const spawnCommand = yield* resolveSpawnCommand(binary, args, { env: environment });
    return yield* spawnAndCollect(
      binary,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        ...(cwd ? { cwd } : {}),
      }),
    );
  });

const discoverSkills = (settings: CopilotSettings, environment: NodeJS.ProcessEnv, cwd?: string) =>
  runCopilotCommand(settings, environment, ["skill", "list", "--json"], cwd).pipe(
    Effect.timeoutOption(SKILLS_TIMEOUT_MS),
    Effect.map((result) =>
      Option.isSome(result) && result.value.code === 0
        ? parseCopilotSkillsCliOutput(result.value.stdout)
        : EMPTY_SKILLS,
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.logWarning("Copilot skill discovery failed.", {
            errorTag: causeErrorTag(cause),
          }).pipe(Effect.as(EMPTY_SKILLS)),
    ),
  );

/** One short-lived runtime lists models and the session's slash commands. */
const discoverViaSdk = (settings: CopilotSettings, environment: NodeJS.ProcessEnv, cwd?: string) =>
  Effect.gen(function* () {
    const client = yield* makeCopilotSdkClient({
      binaryPath: settings.binaryPath,
      environment,
      ...(cwd ? { cwd } : {}),
      startTimeoutMs: DISCOVERY_START_TIMEOUT_MS,
    });
    const models = buildCopilotModels(yield* client.listModels);
    const slashCommands = yield* Effect.acquireUseRelease(
      client.createSession({
        ...(cwd ? { workingDirectory: cwd } : {}),
        enableConfigDiscovery: false,
        enableSkills: false,
        onPermissionRequest: () => ({ kind: "reject" }),
      }),
      (session) =>
        Effect.tryPromise(() =>
          session.rpc.commands.list({
            includeBuiltins: true,
            includeSkills: false,
            includeClientCommands: false,
          }),
        ).pipe(
          Effect.map((list) => mapCopilotSlashCommands(list.commands)),
          Effect.orElseSucceed(() => EMPTY_SLASH_COMMANDS),
        ),
      (session) => Effect.promise(() => session.disconnect().catch(() => {})),
    );
    return { models, slashCommands };
  }).pipe(Effect.scoped);

export function buildInitialCopilotProviderSnapshot(
  settings: CopilotSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: copilotModels(settings),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking GitHub Copilot CLI availability..."
          : "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  });
}

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  settings: CopilotSettings,
  environment: NodeJS.ProcessEnv,
  options: {
    // Keeps the last good catalog so a transient discovery failure doesn't hide models.
    readonly discoveredModelsRef: Ref.Ref<ReadonlyArray<ServerProviderModel>>;
    readonly cwd?: string;
  },
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const previousModels = yield* Ref.get(options.discoveredModelsRef);
  const unavailable = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) =>
    buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: copilotModels(settings, previousModels),
      probe,
    });

  if (!settings.enabled) {
    return unavailable({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "GitHub Copilot is disabled in T3 Code settings.",
    });
  }

  const versionProbe = yield* runCopilotCommand(settings, environment, ["version"]).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionProbe)) {
    const missing = isCommandMissingCause(versionProbe.failure);
    return unavailable({
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
        : "Failed to execute the GitHub Copilot CLI health check.",
    });
  }
  if (Option.isNone(versionProbe.success)) {
    return unavailable({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "GitHub Copilot CLI timed out while running `copilot version`.",
    });
  }
  const output = versionProbe.success.value;
  const version = parseCopilotVersion(`${output.stdout}\n${output.stderr}`);
  if (output.code !== 0 || version === null) {
    return unavailable({
      installed: true,
      version,
      status: output.code !== 0 ? "error" : "warning",
      auth: { status: "unknown" },
      message:
        output.code !== 0
          ? `GitHub Copilot CLI health check failed (exit code ${output.code}).`
          : "Could not parse a version from `copilot version`; check that the binary is the GitHub Copilot CLI.",
    });
  }

  const auth = detectCopilotAuthFromEnvironment(environment);
  const discovery = yield* discoverViaSdk(settings, environment, options.cwd).pipe(
    Effect.timeoutOption(DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  const skills = yield* discoverSkills(settings, environment, options.cwd);
  const discovered =
    discovery._tag === "Success" && Option.isSome(discovery.value)
      ? discovery.value.value
      : undefined;
  if (discovery._tag === "Failure")
    yield* Effect.logWarning("Copilot SDK discovery failed.", {
      errorTag: causeErrorTag(discovery.cause),
    });
  if (discovered && discovered.models.length > 0)
    yield* Ref.set(options.discoveredModelsRef, discovered.models);
  const models = discovered?.models.length ? discovered.models : previousModels;
  const message =
    discovered === undefined
      ? `GitHub Copilot model discovery failed${previousModels.length > 0 ? "; showing the last known models." : "."}`
      : models.length === 0
        ? "GitHub Copilot returned no models. Run `copilot` in a terminal and use /login."
        : undefined;

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: copilotModels(settings, models),
    slashCommands: discovered?.slashCommands ?? EMPTY_SLASH_COMMANDS,
    skills,
    probe: {
      installed: true,
      version,
      status: message ? "warning" : "ready",
      auth: models.length > 0 && auth.status === "unknown" ? { status: "authenticated" } : auth,
      ...(message ? { message } : {}),
    },
  });
});

export const enrichCopilotSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("Copilot version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
