/**
 * Drives a real `copilot` binary. Set COPILOT_LIVE_BINARY to its path to run;
 * each case sends one short prompt to the signed-in account.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CopilotSettings } from "../settings.ts";
import { makeCopilotAdapterV2 } from "./adapter.ts";

const binary = process.env.COPILOT_LIVE_BINARY;
const INSTANCE_ID = ProviderInstanceId.make("copilot");
const THREAD_ID = ThreadId.make("thread-copilot-live");
const MODEL = process.env.COPILOT_LIVE_MODEL ?? "claude-haiku-4.5";
const settings = Schema.decodeSync(CopilotSettings)({ enabled: true, binaryPath: binary });

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const runLiveTurn = Effect.fnUntraced(function* (input: {
  readonly runtimeMode: RuntimeMode;
  readonly prompt: string;
  readonly onEvent?: (
    event: ProviderAdapter.ProviderAdapterV2Event,
    runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-copilot-live-" });
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    cwd,
  });
  const modelSelection = { instanceId: INSTANCE_ID, model: MODEL };
  const adapter = yield* makeCopilotAdapterV2({
    instanceId: INSTANCE_ID,
    settings,
    environment: process.env,
  });
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: ProviderSessionId.make("session-copilot-live"),
    modelSelection,
    runtimePolicy,
  });
  const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const terminal = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        events.push(event);
        if (input.onEvent) yield* input.onEvent(event, runtime);
        if (event.type === "turn.terminal") yield* Queue.offer(terminal, event);
      }),
    ),
    Effect.forkScoped,
  );
  const providerThread: OrchestrationV2ProviderThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection,
    runtimePolicy,
  });
  const now = yield* DateTime.now;
  yield* runtime.startTurn({
    appThread: {
      id: THREAD_ID,
      projectId: ProjectId.make("project-copilot-live"),
      title: "Copilot live",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: INSTANCE_ID,
      modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId: THREAD_ID,
    runId: RunId.make("run-1"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt-1"),
    rootNodeId: NodeId.make("root-1"),
    providerThread,
    message: {
      messageId: MessageId.make("message-1"),
      text: input.prompt,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy,
  });
  const done = yield* Queue.take(terminal).pipe(Effect.timeout(120_000));
  return { done, events };
});

const turnItems = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
  events.flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));

describe.skipIf(!binary)("Copilot SDK adapter (live)", () => {
  it.layer(testLayer, { timeout: 180_000 })((it) => {
    it.effect("completes a turn with a streamed assistant message", () =>
      Effect.gen(function* () {
        const { done, events } = yield* runLiveTurn({
          runtimeMode: "full-access",
          prompt: "Reply with exactly the word: pong",
        });
        assert.equal(done.type === "turn.terminal" ? done.status : undefined, "completed");
        const reply = turnItems(events).findLast((item) => item.type === "assistant_message");
        assert.include(reply?.type === "assistant_message" ? reply.text.toLowerCase() : "", "pong");
        assert.isFalse(reply?.type === "assistant_message" ? reply.streaming : true);
      }).pipe(Effect.scoped),
    );

    it.effect("asks for shell approval and runs the command once accepted", () =>
      Effect.gen(function* () {
        const { done, events } = yield* runLiveTurn({
          runtimeMode: "approval-required",
          prompt: "Run the shell command `echo copilot-live` and tell me its output.",
          onEvent: (event, runtime) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
              ? runtime.respondToRuntimeRequest({
                  requestId: event.runtimeRequest.id,
                  decision: "accept",
                })
              : Effect.void,
        });
        assert.equal(done.type === "turn.terminal" ? done.status : undefined, "completed");
        const requests = events.filter((event) => event.type === "runtime_request.updated");
        assert.isTrue(requests.some((event) => event.runtimeRequest.status === "resolved"));
        const command = turnItems(events).findLast((item) => item.type === "command_execution");
        assert.include(
          command?.type === "command_execution" ? (command.output ?? "") : "",
          "copilot-live",
        );
      }).pipe(Effect.scoped),
    );
  });
});
