import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import {
  type CopilotLogMessage,
  parseCopilotLogMessages,
  planForeignMessages,
} from "./CopilotTranscriptSync.ts";

const threadId = ThreadId.make("thread-1");

const user = (eventId: string, text: string): CopilotLogMessage => ({
  eventId,
  role: "user",
  text,
  createdAt: "2026-10-17T10:00:00.000Z",
});
const assistant = (eventId: string, text: string): CopilotLogMessage => ({
  eventId,
  role: "assistant",
  text,
  createdAt: "2026-10-17T10:00:01.000Z",
});

describe("parseCopilotLogMessages", () => {
  it("keeps top-level conversation messages only", () => {
    const contents = [
      { type: "session.start", id: "e0", timestamp: "t", data: { sessionId: "s" } },
      { type: "user.message", id: "e1", timestamp: "t", data: { content: " Fix it " } },
      {
        type: "assistant.message",
        id: "e2",
        timestamp: "t",
        data: { content: "Task", parentToolCallId: "x" },
      },
      {
        type: "assistant.message",
        id: "e3",
        timestamp: "t",
        agentId: "explore",
        data: { content: "Sub" },
      },
      { type: "assistant.message", id: "e4", timestamp: "t", data: { content: "Fixed" } },
    ]
      .map((record) => JSON.stringify(record))
      .concat("{not json")
      .join("\n");
    expect(parseCopilotLogMessages(contents).map((message) => message.eventId)).toEqual([
      "e1",
      "e4",
    ]);
  });
});

describe("planForeignMessages", () => {
  const log = [
    user("u1", "First"),
    assistant("a1", "Reply one"),
    user("u2", "Second"),
    assistant("a2", "Reply two"),
    user("u3", "From VS Code"),
    assistant("a3", "Reply three"),
  ];

  it("appends turns after the thread's newest matching prompt", () => {
    expect(
      planForeignMessages({
        threadId,
        log,
        recentUserMessages: [
          { messageId: "m2", text: "Second" },
          { messageId: "m1", text: "First" },
        ],
      }).map((message) => message.eventId),
    ).toEqual(["u3", "a3"]);
  });

  it("finds nothing once the thread holds the newest prompt", () => {
    expect(
      planForeignMessages({
        threadId,
        log,
        recentUserMessages: [{ messageId: "m3", text: "From VS Code" }],
      }),
    ).toEqual([]);
  });

  it("continues a synced turn from its exact event", () => {
    expect(
      planForeignMessages({
        threadId,
        log,
        recentUserMessages: [{ messageId: `${threadId}:copilot:u3`, text: "From VS Code" }],
      }).map((message) => message.eventId),
    ).toEqual(["a3"]);
  });

  it("skips prompts missing from the log, such as slash commands", () => {
    expect(
      planForeignMessages({
        threadId,
        log,
        recentUserMessages: [
          { messageId: "m4", text: "/skills" },
          { messageId: "m2", text: "Second" },
        ],
      }).map((message) => message.eventId),
    ).toEqual(["u3", "a3"]);
  });

  it("matches a prompt sent with attachment paths appended", () => {
    expect(
      planForeignMessages({
        threadId,
        log: [user("u1", "Look\n\n/tmp/a.png"), assistant("a1", "Seen"), user("u2", "Next")],
        recentUserMessages: [{ messageId: "m1", text: "Look" }],
      }).map((message) => message.eventId),
    ).toEqual(["u2"]);
  });

  it("does nothing when no thread prompt appears in the log", () => {
    expect(
      planForeignMessages({
        threadId,
        log,
        recentUserMessages: [{ messageId: "m9", text: "Unrelated" }],
      }),
    ).toEqual([]);
  });
});
