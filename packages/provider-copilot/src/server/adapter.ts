import type {
  CopilotSession,
  ExitPlanModeRequest,
  MessageOptions,
  PermissionRequest,
  PermissionRequestResult,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import {
  ProviderDriverKind,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2TurnItemStatus,
  type PlanId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderInstanceId,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

import { CopilotSettings } from "../settings.ts";
import { parseCopilotSlashCommand } from "./commands.ts";
import {
  HIDDEN_COPILOT_TOOLS,
  copilotPermissionOffersSession,
  copilotPermissionPrompt,
  copilotRequestKind,
  copilotToolPresentation,
  copilotToolTitle,
  type CopilotToolState,
} from "./itemPresentation.ts";
import { resolveCopilotTunables, type CopilotSessionTunables } from "./models.ts";
import { makeCopilotSdkClient, type CopilotSdkClient } from "./sdkClient.ts";

export const COPILOT_PROVIDER = ProviderDriverKind.make("copilot");
const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);
const isProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);

const CopilotProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: false,
    emitsProposedPlan: true,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "none",
    nativeItemIds: "strong",
    nativeRequestIds: "none",
  },
} satisfies OrchestrationV2ProviderCapabilities;

const PLAN_CAPTURED_FEEDBACK =
  "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.";

export interface CopilotAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CopilotSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: ProviderEventLoggers.EventNdjsonLogger;
  readonly requestTimeoutMs?: number;
}

interface ItemState {
  readonly kind: "assistant" | "reasoning" | "tool";
  text: string;
  status: OrchestrationV2TurnItemStatus;
  tool?: CopilotToolState;
}

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly nativeId: string;
  readonly items: Map<string, ItemState>;
  readonly ordinals: Map<string, number>;
  readonly started: Map<string, DateTime.Utc>;
  readonly dirty: Set<string>;
  readonly hiddenTools: Set<string>;
  readonly done: Deferred.Deferred<void>;
  nextOrdinal: number;
  flushScheduled: boolean;
  interruptRequested: boolean;
  planId?: PlanId;
}

interface PendingApproval {
  request: OrchestrationV2RuntimeRequest;
  node: OrchestrationV2ExecutionNode;
  item: OrchestrationV2TurnItem;
  readonly respond: (result: PermissionRequestResult) => void;
  decision?: ProviderApprovalDecision;
}

type Inbox =
  | { readonly type: "event"; readonly event: SessionEvent }
  | {
      readonly type: "permission";
      readonly request: PermissionRequest;
      readonly respond: (result: PermissionRequestResult) => void;
    }
  | { readonly type: "plan"; readonly request: ExitPlanModeRequest }
  | { readonly type: "flush"; readonly turn: ActiveTurn };

const nativeRef = (nativeId: string) => ({
  driver: COPILOT_PROVIDER,
  nativeId,
  strength: "strong" as const,
});

function decisionResult(decision: ProviderApprovalDecision): PermissionRequestResult {
  switch (decision) {
    case "accept":
      return { kind: "approve-once" };
    case "acceptForSession":
    case "acceptAlways":
      return { kind: "approve-for-session" };
    default:
      return { kind: "reject" };
  }
}

function approvalOptions(request: PermissionRequest): ReadonlyArray<ProviderApprovalOption> {
  return [
    { decision: "accept", label: "Allow once" },
    ...(copilotPermissionOffersSession(request)
      ? [{ decision: "acceptForSession" as const, label: "Allow for this session" }]
      : []),
    { decision: "decline", label: "Deny" },
  ];
}

function failureClass(errorType: string) {
  switch (errorType) {
    case "rate_limit":
    case "quota":
      return "usage_limit" as const;
    case "authentication":
    case "authorization":
      return "permission_error" as const;
    default:
      return "provider_error" as const;
  }
}

export const makeCopilotAdapterV2 = Effect.fn("makeCopilotAdapterV2")(function* (
  options: CopilotAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const providerHost = yield* ProviderHost.ProviderHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;

  const protocolError = (detail: string, cause?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: COPILOT_PROVIDER,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: COPILOT_PROVIDER,
    getCapabilities: () => Effect.succeed(CopilotProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("CopilotAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      if (!options.settings.enabled) return yield* protocolError("GitHub Copilot is disabled");
      const scope = yield* Effect.scope;
      const requestedCwd = input.runtimePolicy.cwd ?? providerHost.paths.cwd;
      const cwd = yield* fileSystem
        .realPath(requestedCwd)
        .pipe(Effect.orElseSucceed(() => requestedCwd));
      const runtimeMode = input.runtimePolicy.runtimeMode;
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: COPILOT_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: CopilotProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const inbox = yield* Queue.unbounded<Inbox>();
      const commands = yield* Semaphore.make(1);
      const eventPermit = yield* Semaphore.make(1);
      let closed = false;
      let broken = false;
      let sdkSession: CopilotSession | undefined;
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: ActiveTurn | undefined;
      let lastProviderTurn: OrchestrationV2ProviderTurn | undefined;
      let slashCommandNames: ReadonlySet<string> = new Set();
      let applied: { model: string | undefined } & CopilotSessionTunables = { model: undefined };
      const pending = new Map<RuntimeRequestId, PendingApproval>();

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const sdkCall = <A>(method: string, run: () => Promise<A>) =>
        Effect.tryPromise({
          try: run,
          catch: (cause) =>
            protocolError(
              cause instanceof Error && cause.message
                ? `Copilot ${method} failed: ${cause.message}`
                : `Copilot ${method} failed`,
              cause,
            ),
        });
      const requireSession = Effect.suspend(() =>
        sdkSession && !closed && !broken
          ? Effect.succeed(sdkSession)
          : Effect.fail(protocolError("Copilot session is unavailable; reopen it")),
      );

      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_session.updated",
          driver: COPILOT_PROVIDER,
          providerSession: session,
        });
      });
      const updateThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (!thread) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_thread.updated",
          driver: COPILOT_PROVIDER,
          providerThread: thread,
        });
      });

      const itemIdentity = (turn: ActiveTurn, nativeId: string) =>
        `${options.instanceId}:${turn.input.providerThread.id}:${turn.nativeId}:${nativeId}`;
      const baseItem = (turn: ActiveTurn, nativeId: string, time: DateTime.Utc) => {
        if (!turn.ordinals.has(nativeId)) turn.ordinals.set(nativeId, turn.nextOrdinal++);
        if (!turn.started.has(nativeId)) turn.started.set(nativeId, time);
        const identity = itemIdentity(turn, nativeId);
        return {
          id: idAllocator.derive.turnItemFromProviderItem({
            driver: COPILOT_PROVIDER,
            nativeItemId: identity,
          }),
          nodeId: idAllocator.derive.nodeFromProviderItem({
            driver: COPILOT_PROVIDER,
            nativeItemId: identity,
          }),
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: nativeRef(nativeId),
          parentItemId: null,
          ordinal: turn.ordinals.get(nativeId)!,
          startedAt: turn.started.get(nativeId)!,
          updatedAt: time,
        };
      };
      const emitNode = (
        turn: ActiveTurn,
        base: ReturnType<typeof baseItem>,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2TurnItemStatus,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver: COPILOT_PROVIDER,
          node: {
            id: base.nodeId,
            threadId: base.threadId,
            runId: base.runId,
            parentNodeId: turn.input.rootNodeId,
            rootNodeId: turn.input.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: base.providerThreadId,
            providerTurnId: base.providerTurnId,
            nativeItemRef: base.nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: base.startedAt,
            completedAt,
          },
        });

      const publishItem = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        nativeId: string,
        terminal?: OrchestrationV2TurnItemStatus,
      ) {
        const item = turn.items.get(nativeId);
        if (!item || (item.kind !== "tool" && !item.text.trim())) return;
        if (terminal && item.status === "running") item.status = terminal;
        const time = yield* DateTime.now;
        const streaming = item.status === "running";
        const completedAt = streaming ? null : time;
        const base = baseItem(turn, nativeId, time);
        if (item.kind === "assistant") {
          const messageId = idAllocator.derive.messageFromProviderItem({
            driver: COPILOT_PROVIDER,
            nativeItemId: itemIdentity(turn, nativeId),
          });
          const message: OrchestrationV2ConversationMessage = {
            id: messageId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: base.nodeId,
            role: "assistant",
            text: item.text,
            attachments: [],
            streaming,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: base.startedAt,
            updatedAt: time,
          };
          yield* emit({ type: "message.updated", driver: COPILOT_PROVIDER, message });
          yield* emitNode(turn, base, "assistant_message", item.status, completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: COPILOT_PROVIDER,
            turnItem: {
              ...base,
              type: "assistant_message",
              status: item.status,
              title: null,
              completedAt,
              messageId,
              text: item.text,
              streaming,
            },
          });
          return;
        }
        if (item.kind === "reasoning") {
          yield* emitNode(turn, base, "reasoning", item.status, completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: COPILOT_PROVIDER,
            turnItem: {
              ...base,
              type: "reasoning",
              status: item.status,
              title: null,
              completedAt,
              text: item.text,
              streaming,
            },
          });
          return;
        }
        const tool = item.tool!;
        yield* emitNode(turn, base, "tool_call", item.status, completedAt);
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: {
            ...base,
            ...copilotToolPresentation(tool),
            status: item.status,
            title: copilotToolTitle(tool),
            completedAt,
          },
        });
      });

      const scheduleFlush = Effect.fnUntraced(function* (turn: ActiveTurn, nativeId: string) {
        turn.dirty.add(nativeId);
        if (turn.flushScheduled) return;
        turn.flushScheduled = true;
        yield* Effect.sleep(50).pipe(
          Effect.andThen(Queue.offer(inbox, { type: "flush", turn })),
          Effect.forkIn(scope),
        );
      });

      const resolvePending = Effect.fnUntraced(function* (
        entry: PendingApproval,
        status: "resolved" | "cancelled",
      ) {
        const time = yield* DateTime.now;
        if (status === "cancelled") entry.respond({ kind: "reject" });
        entry.request = {
          ...entry.request,
          ...(status === "resolved" && entry.decision ? { decision: entry.decision } : {}),
          status,
          resolvedAt: time,
          responseCapability: { type: "not_resumable", reason: "This Copilot request has ended." },
        };
        entry.node = {
          ...entry.node,
          status: status === "resolved" ? "completed" : "cancelled",
          completedAt: time,
        };
        entry.item = {
          ...entry.item,
          status: status === "resolved" ? "completed" : "cancelled",
          completedAt: time,
          updatedAt: time,
        };
        pending.delete(entry.request.id);
        yield* emit({
          type: "runtime_request.updated",
          driver: COPILOT_PROVIDER,
          threadId: entry.node.threadId,
          runtimeRequest: entry.request,
        });
        yield* emit({ type: "node.updated", driver: COPILOT_PROVIDER, node: entry.node });
        yield* emit({ type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem: entry.item });
      });

      const finish = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        status: "completed" | "cancelled" | "interrupted" | "failed",
        failure?: {
          readonly message: string;
          readonly class?: ReturnType<typeof failureClass> | "transport_error";
          readonly code?: string;
        },
        disposition: "reusable" | "broken" = "reusable",
      ) {
        if (active !== turn) return;
        const completedAt = yield* DateTime.now;
        const itemTerminal = status === "completed" ? "completed" : status;
        for (const nativeId of turn.items.keys()) {
          const item = turn.items.get(nativeId)!;
          if (turn.dirty.has(nativeId) || item.status === "running")
            yield* publishItem(turn, nativeId, itemTerminal);
        }
        turn.dirty.clear();
        for (const entry of pending.values()) yield* resolvePending(entry, "cancelled");
        turn.providerTurn = { ...turn.providerTurn, status, completedAt };
        lastProviderTurn = turn.providerTurn;
        yield* emit({
          type: "provider_turn.updated",
          driver: COPILOT_PROVIDER,
          threadId: turn.input.threadId,
          providerTurn: turn.providerTurn,
        });
        yield* updateThread({ status: disposition === "broken" ? "error" : "idle" });
        yield* updateSession(
          disposition === "broken" ? "error" : "ready",
          failure?.message ?? null,
        );
        active = undefined;
        if (status === "failed") {
          const providerFailure = makeProviderFailure({
            class:
              failure?.class ?? (disposition === "broken" ? "transport_error" : "provider_error"),
            message: failure?.message ?? "GitHub Copilot turn failed.",
            ...(failure?.code ? { code: failure.code } : {}),
          });
          const base = baseItem(turn, `failure:${turn.nativeId}`, completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: COPILOT_PROVIDER,
            turnItem: {
              ...base,
              type: "error",
              status: "failed",
              title: null,
              completedAt,
              failure: providerFailure,
            },
          });
          yield* emit({
            type: "turn.terminal",
            driver: COPILOT_PROVIDER,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure: providerFailure,
            failureItemOrdinal: base.ordinal,
            threadDisposition: disposition,
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver: COPILOT_PROVIDER,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure: null,
            threadDisposition: disposition,
          });
        }
        yield* Deferred.succeed(turn.done, undefined);
      });

      const failSession = Effect.fnUntraced(function* (detail: string, cause?: unknown) {
        if (closed || broken) return;
        broken = true;
        if (active)
          yield* finish(active, "failed", { message: detail, class: "transport_error" }, "broken");
        else {
          yield* updateThread({ status: "error" });
          yield* updateSession("error", detail);
        }
        for (const entry of pending.values()) yield* resolvePending(entry, "cancelled");
        yield* Queue.fail(events, protocolError(detail, cause));
      });

      const publishPermission = Effect.fnUntraced(function* (
        request: PermissionRequest,
        respond: (result: PermissionRequestResult) => void,
      ) {
        const turn = active;
        if (!turn || !thread) {
          respond({ kind: "reject" });
          return;
        }
        const nativeId = request.toolCallId ?? `permission:${turn.nextOrdinal}`;
        const requestId = yield* idAllocator.allocate
          .runtimeRequest({
            driver: COPILOT_PROVIDER,
            providerTurnId: turn.providerTurn.id,
            nativeRequestId: nativeId,
          })
          .pipe(
            Effect.mapError((cause) => protocolError("Cannot allocate Copilot request", cause)),
          );
        const time = yield* DateTime.now;
        const kind = copilotRequestKind(request);
        const nodeId = idAllocator.derive.approvalNode({ requestId });
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId: turn.providerTurn.id,
          nativeRequestRef: { ...nativeRef(nativeId), strength: "weak" },
          kind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt: time,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind: "approval_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: thread.id,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef: runtimeRequest.nativeRequestRef,
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: time,
          completedAt: null,
        };
        const item: OrchestrationV2TurnItem = {
          ...baseItem(turn, `request:${requestId}`, time),
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          nodeId,
          type: "approval_request",
          status: "waiting",
          title: null,
          completedAt: null,
          requestId,
          requestKind: kind,
          prompt: copilotPermissionPrompt(request),
          options: approvalOptions(request),
        };
        pending.set(requestId, { request: runtimeRequest, node, item, respond });
        yield* emit({
          type: "runtime_request.updated",
          driver: COPILOT_PROVIDER,
          threadId: turn.input.threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: COPILOT_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: COPILOT_PROVIDER, turnItem: item });
        yield* updateSession("waiting");
      });

      const publishProposedPlan = Effect.fnUntraced(function* (request: ExitPlanModeRequest) {
        const turn = active;
        if (!turn) return;
        const markdown = (request.planContent ?? request.summary).trim();
        if (!markdown) return;
        const time = yield* DateTime.now;
        const planId =
          turn.planId ??
          (yield* idAllocator.allocate
            .plan({
              threadId: turn.input.threadId,
              runId: turn.input.runId,
              driver: COPILOT_PROVIDER,
            })
            .pipe(
              Effect.mapError((cause) => protocolError("Cannot allocate Copilot plan", cause)),
            ));
        turn.planId = planId;
        const base = baseItem(turn, "proposed_plan", time);
        yield* emitNode(turn, base, "plan", "completed", time);
        yield* emit({
          type: "plan.updated",
          driver: COPILOT_PROVIDER,
          plan: {
            id: planId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: base.nodeId,
            kind: "proposed_plan",
            status: "active",
            markdown,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: COPILOT_PROVIDER,
          turnItem: {
            ...base,
            type: "proposed_plan",
            status: "completed",
            title: null,
            completedAt: time,
            planId,
            markdown,
            streaming: false,
          },
        });
      });

      const handleEvent = Effect.fnUntraced(function* (event: SessionEvent) {
        // Sub-agent events belong to a nested run, not this turn.
        if (event.agentId !== undefined) {
          if (event.type === "session.error")
            yield* Effect.logWarning("Copilot sub-agent session error", {
              errorType: event.data.errorType,
            });
          return;
        }
        if (event.type === "session.shutdown") {
          if (event.data.shutdownType === "error")
            return yield* failSession(
              event.data.errorReason?.trim() || "GitHub Copilot runtime shut down unexpectedly.",
            );
          if (active) yield* finish(active, "cancelled", undefined, "broken");
          return;
        }
        if (event.type === "session.usage_info") {
          const contextUsage = {
            usedTokens: Math.max(0, Math.round(event.data.currentTokens)),
            ...(event.data.tokenLimit > 0 ? { maxTokens: Math.round(event.data.tokenLimit) } : {}),
          };
          yield* updateThread({ contextUsage });
          const currentTurn = active?.providerTurn ?? lastProviderTurn;
          if (currentTurn) {
            const updated = {
              ...currentTurn,
              tokenUsage: {
                ...contextUsage,
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              },
            };
            if (active) active.providerTurn = updated;
            else lastProviderTurn = updated;
            yield* emit({
              type: "provider_turn.updated",
              driver: COPILOT_PROVIDER,
              providerTurn: updated,
            });
          }
          return;
        }
        const turn = active;
        if (!turn) return;
        switch (event.type) {
          case "assistant.message_start": {
            if (!turn.items.has(event.data.messageId))
              turn.items.set(event.data.messageId, {
                kind: "assistant",
                text: "",
                status: "running",
              });
            return;
          }
          case "assistant.message_delta": {
            if (event.data.parentToolCallId || !event.data.deltaContent) return;
            const item = turn.items.get(event.data.messageId) ?? {
              kind: "assistant" as const,
              text: "",
              status: "running" as const,
            };
            item.text += event.data.deltaContent;
            turn.items.set(event.data.messageId, item);
            return yield* scheduleFlush(turn, event.data.messageId);
          }
          case "assistant.message": {
            if (event.data.parentToolCallId) return;
            const existing = turn.items.get(event.data.messageId);
            const text = event.data.content || existing?.text || "";
            if (!text.trim()) {
              turn.items.delete(event.data.messageId);
              return;
            }
            turn.items.set(event.data.messageId, { kind: "assistant", text, status: "completed" });
            turn.dirty.delete(event.data.messageId);
            return yield* publishItem(turn, event.data.messageId);
          }
          case "assistant.reasoning_delta": {
            if (!event.data.deltaContent) return;
            const item = turn.items.get(event.data.reasoningId) ?? {
              kind: "reasoning" as const,
              text: "",
              status: "running" as const,
            };
            item.text += event.data.deltaContent;
            turn.items.set(event.data.reasoningId, item);
            return yield* scheduleFlush(turn, event.data.reasoningId);
          }
          case "assistant.reasoning": {
            const existing = turn.items.get(event.data.reasoningId);
            const text = event.data.content || existing?.text || "";
            if (!text.trim()) {
              turn.items.delete(event.data.reasoningId);
              return;
            }
            turn.items.set(event.data.reasoningId, {
              kind: "reasoning",
              text,
              status: "completed",
            });
            turn.dirty.delete(event.data.reasoningId);
            return yield* publishItem(turn, event.data.reasoningId);
          }
          case "tool.execution_start": {
            if (HIDDEN_COPILOT_TOOLS.has(event.data.toolName)) {
              turn.hiddenTools.add(event.data.toolCallId);
              return;
            }
            turn.items.set(event.data.toolCallId, {
              kind: "tool",
              text: "",
              status: "running",
              tool: {
                toolName: event.data.toolName,
                mcpServerName: event.data.mcpServerName,
                mcpToolName: event.data.mcpToolName,
                arguments: event.data.arguments,
                shellCommand: event.data.shellToolInfo?.displayCommand,
                output: "",
              },
            });
            return yield* publishItem(turn, event.data.toolCallId);
          }
          case "tool.shell_output": {
            const item = turn.items.get(event.data.toolCallId);
            if (!item || item.status !== "running" || !event.data.text) return;
            return yield* emit({
              type: "command_output.delta",
              driver: COPILOT_PROVIDER,
              threadId: turn.input.threadId,
              itemId: baseItem(turn, event.data.toolCallId, yield* DateTime.now).id,
              chunk: event.data.text,
            });
          }
          case "tool.execution_complete": {
            if (turn.hiddenTools.delete(event.data.toolCallId)) return;
            const item = turn.items.get(event.data.toolCallId);
            if (!item?.tool) return;
            item.tool.output = event.data.result?.content ?? "";
            item.tool.detail = event.data.error?.message?.trim() || undefined;
            item.tool.exitCode = event.data.shellExecution?.exitCode;
            item.status = event.data.success ? "completed" : "failed";
            return yield* publishItem(turn, event.data.toolCallId);
          }
          case "session.idle":
            return yield* finish(
              turn,
              event.data.aborted === true
                ? turn.interruptRequested
                  ? "interrupted"
                  : "cancelled"
                : "completed",
            );
          case "session.error":
            // A rate limit eligible for auto-switch still ends the turn: T3 registers no
            // auto-mode handler, so the runtime declines the switch.
            return yield* finish(turn, "failed", {
              message: event.data.message?.trim() || "GitHub Copilot session error.",
              class: failureClass(event.data.errorType),
              ...(event.data.errorCode ? { code: event.data.errorCode } : {}),
            });
          default:
            return;
        }
      });

      yield* Stream.fromQueue(inbox).pipe(
        Stream.runForEach((entry) =>
          Effect.gen(function* () {
            switch (entry.type) {
              case "flush": {
                const turn = entry.turn;
                turn.flushScheduled = false;
                if (active !== turn) return;
                for (const nativeId of turn.dirty) yield* publishItem(turn, nativeId);
                turn.dirty.clear();
                return;
              }
              case "permission":
                return yield* publishPermission(entry.request, entry.respond).pipe(
                  Effect.catch((cause) =>
                    Effect.sync(() => entry.respond({ kind: "reject" })).pipe(
                      Effect.andThen(Effect.logWarning("Copilot permission request failed", cause)),
                    ),
                  ),
                );
              case "plan":
                return yield* publishProposedPlan(entry.request).pipe(
                  Effect.catch((cause) => Effect.logWarning("Copilot plan capture failed", cause)),
                );
              case "event": {
                const ephemeral = "ephemeral" in entry.event && entry.event.ephemeral === true;
                if (options.nativeEventLogger && !ephemeral)
                  yield* options.nativeEventLogger.write(
                    { provider: "copilot", method: entry.event.type, params: entry.event },
                    input.threadId,
                  );
                return yield* handleEvent(entry.event);
              }
            }
          }).pipe(eventPermit.withPermits(1)),
        ),
        Effect.forkIn(scope),
      );

      const mcpSession = yield* mcpSessions.read(input.threadId);
      const client: CopilotSdkClient = yield* makeCopilotSdkClient({
        binaryPath: options.settings.binaryPath,
        environment: McpProviderSession.withAgentDeviceEnvironment(options.environment, mcpSession),
        cwd,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: COPILOT_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          if (active) yield* finish(active, "cancelled", undefined, "broken");
          for (const entry of pending.values()) yield* resolvePending(entry, "cancelled");
          const current = sdkSession;
          sdkSession = undefined;
          if (current) yield* Effect.promise(() => current.disconnect().catch(() => {}));
          yield* Queue.shutdown(inbox);
          yield* Queue.shutdown(events);
        }).pipe(eventPermit.withPermits(1)),
      );

      const sessionConfig = (
        modelSelection: ModelSelection,
      ): SessionConfig & ResumeSessionConfig => {
        const tunables = resolveCopilotTunables(modelSelection);
        return {
          workingDirectory: cwd,
          streaming: true,
          enableConfigDiscovery: true,
          enableSkills: true,
          systemMessage: {
            mode: "append",
            content: buildRuntimeInstructions({ harness: "GitHub Copilot" }),
          },
          ...(mcpSession
            ? {
                mcpServers: {
                  "t3-code": {
                    type: "http" as const,
                    url: mcpSession.endpoint,
                    headers: { Authorization: mcpSession.authorizationHeader },
                    tools: ["*"],
                  },
                },
              }
            : {}),
          onEvent: (event) => Queue.offerUnsafe(inbox, { type: "event", event }),
          onPermissionRequest: (request) =>
            runtimeMode === "full-access"
              ? { kind: "approve-once" }
              : new Promise<PermissionRequestResult>((respond) =>
                  Queue.offerUnsafe(inbox, { type: "permission", request, respond }),
                ),
          onExitPlanModeRequest: (request) => {
            Queue.offerUnsafe(inbox, { type: "plan", request });
            return { approved: false, feedback: PLAN_CAPTURED_FEEDBACK };
          },
          ...(modelSelection.model ? { model: modelSelection.model } : {}),
          ...(tunables.reasoningEffort ? { reasoningEffort: tunables.reasoningEffort } : {}),
          ...(tunables.contextTier ? { contextTier: tunables.contextTier } : {}),
        } as SessionConfig & ResumeSessionConfig;
      };

      const register = Effect.fnUntraced(function* (
        args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        if (broken || closed) return yield* protocolError("Copilot session is unavailable");
        if (active) return yield* protocolError("Cannot change Copilot sessions during a turn");
        const existing = args.existingProviderThread;
        if (
          existing &&
          (existing.driver !== COPILOT_PROVIDER ||
            existing.providerInstanceId !== options.instanceId)
        )
          return yield* protocolError("Copilot thread belongs to another provider instance");
        const requestedId = existing?.nativeThreadRef?.nativeId ?? input.initialNativeThreadId;
        if (thread && sdkSession && (!requestedId || requestedId === sdkSession.sessionId))
          return thread;
        if (thread)
          return yield* protocolError("Open a new session to attach another Copilot thread");
        const config = sessionConfig(args.modelSelection);
        const created = yield* (
          requestedId ? client.resumeSession(requestedId, config) : client.createSession(config)
        ).pipe(
          Effect.mapError((cause) => protocolError("Copilot could not open its session", cause)),
        );
        sdkSession = created;
        applied = {
          model: args.modelSelection.model,
          ...resolveCopilotTunables(args.modelSelection),
        };
        slashCommandNames = yield* sdkCall("commands.list", () =>
          created.rpc.commands.list({
            includeBuiltins: true,
            includeSkills: true,
            includeClientCommands: false,
          }),
        ).pipe(
          Effect.map(
            (list) =>
              new Set(
                list.commands
                  .map((command) => command.name.trim().toLowerCase())
                  .filter((name) => name.length > 0),
              ),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Copilot slash-command discovery failed", cause).pipe(
              Effect.as(new Set<string>()),
            ),
          ),
        );
        const createdAt = yield* DateTime.now;
        thread = existing
          ? {
              ...existing,
              providerSessionId: input.providerSessionId,
              nativeThreadRef: nativeRef(created.sessionId),
              status: "idle",
              updatedAt: createdAt,
            }
          : {
              id: idAllocator.derive.providerThread({
                driver: COPILOT_PROVIDER,
                providerInstanceId: options.instanceId,
                nativeThreadId: created.sessionId,
              }),
              driver: COPILOT_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: args.threadId,
              ownerNodeId: null,
              nativeThreadRef: nativeRef(created.sessionId),
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            };
        session = { ...session, model: args.modelSelection.model };
        yield* emit({
          type: "provider_thread.updated",
          driver: COPILOT_PROVIDER,
          providerThread: thread,
        });
        return thread;
      });

      const validateThread = (candidate: OrchestrationV2ProviderThread) =>
        thread !== undefined &&
        candidate.driver === COPILOT_PROVIDER &&
        candidate.providerInstanceId === options.instanceId &&
        candidate.nativeThreadRef?.nativeId === sdkSession?.sessionId;

      const buildMessage = Effect.fnUntraced(function* (
        message: ProviderAdapter.ProviderAdapterV2TurnMessage,
      ) {
        const prompt = providerMessageTextWithAttachmentPaths({
          text: message.text,
          attachments: message.attachments,
          resolveAttachmentPath: providerHost.resolveAttachmentPath,
        });
        const attachments: NonNullable<MessageOptions["attachments"]> = [];
        for (const attachment of message.attachments) {
          if (!isProviderNativeImageAttachment(attachment)) continue;
          const path = providerHost.resolveAttachmentPath(attachment);
          if (!path) return yield* protocolError("Copilot image attachment is missing");
          attachments.push({ type: "file", path, displayName: attachment.name });
        }
        if (!prompt.trim() && attachments.length === 0)
          return yield* protocolError("Copilot needs text or an attachment");
        return { prompt, ...(attachments.length > 0 ? { attachments } : {}) };
      });

      const applyModelSelection = Effect.fnUntraced(function* (
        current: CopilotSession,
        selection: ModelSelection,
      ) {
        if (selection.instanceId !== options.instanceId)
          return yield* protocolError("Model selection belongs to another Copilot instance");
        const tunables = resolveCopilotTunables(selection);
        const model = selection.model || applied.model;
        if (
          !model ||
          (model === applied.model &&
            tunables.reasoningEffort === applied.reasoningEffort &&
            tunables.contextTier === applied.contextTier)
        )
          return;
        yield* sdkCall("setModel", () =>
          current.setModel(model, tunables as Parameters<CopilotSession["setModel"]>[1]),
        );
        applied = { model, ...tunables };
        session = { ...session, model };
      });

      const runSlashCommand = Effect.fnUntraced(function* (
        current: CopilotSession,
        turn: ActiveTurn,
        command: { readonly name: string; readonly input?: string },
        agentMode: "interactive" | "plan",
      ) {
        const result = yield* sdkCall("commands.invoke", () =>
          current.rpc.commands.invoke(command),
        );
        if (result.kind === "agent-prompt") {
          yield* sdkCall("send", () =>
            current.send({
              prompt: result.prompt,
              displayPrompt: result.displayPrompt,
              agentMode: result.mode === "plan" ? "plan" : agentMode,
            }),
          );
          return;
        }
        const text =
          result.kind === "text"
            ? result.text
            : result.kind === "completed"
              ? (result.message ?? "")
              : result.kind === "select-subcommand"
                ? [
                    result.title,
                    ...result.options.map((option) => `- ${option.name}: ${option.description}`),
                  ].join("\n")
                : result.kind === "set-model"
                  ? `Model set to ${result.model}.`
                  : result.kind === "set-plan-model"
                    ? result.message
                    : "";
        yield* eventPermit.withPermits(1)(
          Effect.gen(function* () {
            if (text.trim()) {
              const nativeId = `command:${command.name}`;
              turn.items.set(nativeId, {
                kind: "assistant",
                text: text.trim(),
                status: "completed",
              });
              yield* publishItem(turn, nativeId);
            }
            yield* finish(turn, "completed");
          }),
        );
      });

      const start = Effect.fnUntraced(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        const current = yield* requireSession;
        if (!validateThread(turnInput.providerThread))
          return yield* protocolError("Copilot thread is not attached to this session");
        if (active)
          return yield* protocolError(
            "Copilot already has an active turn; queue through the orchestrator",
          );
        if (turnInput.runtimePolicy.runtimeMode !== runtimeMode)
          return yield* protocolError("Runtime policy changes require a fresh Copilot session");
        const message = yield* buildMessage(turnInput.message);
        yield* applyModelSelection(current, turnInput.modelSelection);
        const agentMode =
          turnInput.runtimePolicy.interactionMode === "plan" ? "plan" : "interactive";
        const slashCommand = parseCopilotSlashCommand(turnInput.message.text, slashCommandNames);
        const nativeId = yield* randomUuidV4;
        const startedAt = yield* DateTime.now;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: idAllocator.derive.providerTurn({
            driver: COPILOT_PROVIDER,
            nativeTurnId: `${options.instanceId}:${current.sessionId}:${nativeId}`,
          }),
          providerThreadId: turnInput.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          nativeTurnRef: null,
          ordinal: turnInput.providerTurnOrdinal,
          status: "running",
          startedAt,
          completedAt: null,
        };
        const turn: ActiveTurn = {
          input: turnInput,
          providerTurn,
          nativeId,
          items: new Map(),
          ordinals: new Map(),
          started: new Map(),
          dirty: new Set(),
          hiddenTools: new Set(),
          done: yield* Deferred.make<void>(),
          nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
          flushScheduled: false,
          interruptRequested: false,
        };
        yield* Effect.gen(function* () {
          thread = turnInput.providerThread;
          active = turn;
          yield* emit({
            type: "provider_turn.updated",
            driver: COPILOT_PROVIDER,
            threadId: turnInput.threadId,
            providerTurn,
          });
          yield* updateThread({
            status: "active",
            firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal,
            lastRunOrdinal: turnInput.runOrdinal,
          });
          yield* updateSession("running");
        }).pipe(eventPermit.withPermits(1));
        yield* (
          slashCommand
            ? runSlashCommand(current, turn, slashCommand, agentMode)
            : sdkCall("send", () => current.send({ ...message, agentMode })).pipe(Effect.asVoid)
        ).pipe(
          Effect.onError((cause) => {
            const error = Cause.squash(cause);
            const detail = isProtocolError(error)
              ? error.detail
              : "GitHub Copilot could not start the turn.";
            return eventPermit.withPermits(1)(finish(turn, "failed", { message: detail }));
          }),
        );
      });

      const snapshot = Effect.fnUntraced(function* (
        current: OrchestrationV2ProviderThread,
      ): Effect.fn.Return<
        ProviderAdapter.ProviderAdapterV2ThreadSnapshot,
        ProviderAdapter.ProviderAdapterV2Error
      > {
        const live = yield* requireSession;
        const history = yield* sdkCall("getEvents", () => live.getEvents());
        const appThreadId = current.appThreadId ?? input.threadId;
        const messages = history.flatMap((event): OrchestrationV2ConversationMessage[] => {
          if (event.agentId !== undefined) return [];
          if (event.type !== "user.message" && event.type !== "assistant.message") return [];
          if (event.type === "assistant.message" && event.data.parentToolCallId) return [];
          const text = event.data.content;
          if (!text.trim()) return [];
          const time = DateTime.makeUnsafe(event.timestamp);
          const assistant = event.type === "assistant.message";
          return [
            {
              id: idAllocator.derive.messageFromProviderItem({
                driver: COPILOT_PROVIDER,
                nativeItemId: `${options.instanceId}:${current.id}:history:${event.id}`,
              }),
              threadId: appThreadId,
              runId: null,
              nodeId: null,
              role: assistant ? "assistant" : "user",
              text,
              attachments: [],
              streaming: false,
              createdBy: assistant ? "agent" : "user",
              creationSource: "provider",
              createdAt: time,
              updatedAt: time,
            },
          ];
        });
        return {
          providerThread: current,
          providerTurns: [],
          messages,
          runtimeRequests: [...pending.values()].map((entry) => entry.request),
        };
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: COPILOT_PROVIDER,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(events),
        ensureThread: (args) =>
          register(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: COPILOT_PROVIDER,
                  threadId: args.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (args) =>
          register({
            threadId: args.threadId ?? args.providerThread.appThreadId ?? input.threadId,
            modelSelection: args.modelSelection ?? input.modelSelection,
            runtimePolicy: args.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: args.providerThread,
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: COPILOT_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: args.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (args) =>
          start(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: COPILOT_PROVIDER,
                  threadId: args.threadId,
                  providerThreadId: args.providerThread.id,
                  runId: args.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (args) =>
          Effect.gen(function* () {
            const current = yield* requireSession;
            const turn = active;
            if (
              !turn ||
              turn.providerTurn.id !== args.providerTurnId ||
              !validateThread(args.providerThread)
            )
              return yield* protocolError("This Copilot turn cannot be steered");
            const message = yield* buildMessage(args.message);
            yield* sdkCall("send", () => current.send({ ...message, mode: "immediate" }));
          }).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver: COPILOT_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  providerTurnId: args.providerTurnId,
                  cause,
                }),
            ),
          ),
        interruptTurn: (args) =>
          Effect.gen(function* () {
            const current = yield* requireSession;
            const turn = active;
            if (
              !turn ||
              turn.providerTurn.id !== args.providerTurnId ||
              !validateThread(args.providerThread)
            )
              return yield* protocolError("This Copilot turn is no longer active");
            turn.interruptRequested = true;
            yield* eventPermit.withPermits(1)(
              Effect.forEach([...pending.values()], (entry) => resolvePending(entry, "cancelled"), {
                discard: true,
              }),
            );
            // An acknowledged abort is followed by this turn's own aborted `session.idle`.
            const acknowledged = yield* Effect.promise(() =>
              current.abort().then(
                () => true,
                () => false,
              ),
            );
            if (!acknowledged) {
              yield* eventPermit.withPermits(1)(finish(turn, "interrupted"));
              return;
            }
            yield* Deferred.await(turn.done).pipe(
              Effect.timeout(options.requestTimeoutMs ?? 30_000),
              Effect.catch(() => eventPermit.withPermits(1)(finish(turn, "interrupted"))),
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver: COPILOT_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  providerTurnId: args.providerTurnId,
                  cause,
                }),
            ),
          ),
        respondToRuntimeRequest: (args) =>
          eventPermit
            .withPermits(1)(
              Effect.gen(function* () {
                const entry = pending.get(args.requestId);
                if (!entry)
                  return yield* protocolError("This Copilot request is no longer pending");
                const decision = args.decision ?? "decline";
                entry.decision = decision;
                entry.respond(decisionResult(decision));
                yield* resolvePending(entry, "resolved");
                if (pending.size === 0) yield* updateSession(active ? "running" : "ready");
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: COPILOT_PROVIDER,
                    requestId: args.requestId,
                    cause,
                  }),
              ),
            ),
        readThreadSnapshot: (args) =>
          (!validateThread(args.providerThread)
            ? protocolError("Snapshot requested for a different Copilot thread")
            : snapshot(args.providerThread)
          ).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                  driver: COPILOT_PROVIDER,
                  providerThreadId: args.providerThread.id,
                  cause,
                }),
            ),
          ),
        rollbackThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: COPILOT_PROVIDER,
              providerThreadId: args.providerThread.id,
              checkpointId: args.target.checkpointId,
              cause: "GitHub Copilot (SDK) does not support conversation rollback in T3 Code.",
            }),
          ),
        forkThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: COPILOT_PROVIDER,
              providerThreadId: args.sourceProviderThread.id,
              cause: "GitHub Copilot (SDK) does not support native forks in T3 Code.",
            }),
          ),
      };
      return runtime;
    }),
  });
});

export type CopilotAdapterV2DriverEnv =
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost;

export const CopilotAdapterV2Driver: ProviderAdapterDriver<
  CopilotSettings,
  CopilotAdapterV2DriverEnv
> = {
  driverKind: COPILOT_PROVIDER,
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => decodeCopilotSettings({}),
  create: Effect.fn("CopilotAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<CopilotSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      return yield* makeCopilotAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: COPILOT_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create GitHub Copilot adapter.",
              cause,
            }),
        ),
      ),
  ),
};
