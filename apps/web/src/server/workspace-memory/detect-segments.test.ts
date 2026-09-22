import { expect, test } from "bun:test";
import {
  detectAdmittedPublicChannelSegments,
  ingestOperationId,
  sourcePayloadHash,
} from "./detect-segments";

const now = new Date("2026-09-21T12:00:00.000Z");

test("a completed-task window is admitted before a later quiet window on leftover messages", () => {
  const taskMessage = {
    id: "m1",
    conversationId: "ch-1",
    workspaceId: "ws-a",
    sequence: 1,
    createdAt: new Date("2026-09-21T11:00:00.000Z"),
    body: "deploy rolled back after we skipped tests",
    senderKind: "human" as const,
    senderHandle: "ada",
  };
  const leftover = {
    ...taskMessage,
    id: "m2",
    sequence: 2,
    createdAt: new Date("2026-09-21T11:30:00.000Z"),
    body: "unrelated standup note",
  };
  const detected = detectAdmittedPublicChannelSegments({
    conversations: [{ id: "ch-1", workspaceId: "ws-a", channelName: "eng" }],
    messages: [taskMessage, leftover],
    tasks: [
      {
        messageId: "m1",
        conversationId: "ch-1",
        workspaceId: "ws-a",
        status: "done",
        updatedAt: new Date("2026-09-21T11:10:00.000Z"),
      },
    ],
    admittedMessageIds: new Set(),
    now,
    quietAfterMs: 15 * 60 * 1000,
  });
  expect(detected.map((row) => row.kind)).toEqual(["completed_task", "quiet_window"]);
  expect(detected[0]?.sourceMessageIds).toEqual(["m1"]);
  expect(detected[1]?.sourceMessageIds).toEqual(["m2"]);
  expect(detected[0]?.conversationKind).toBe("public_channel");
  expect(detected[0]?.closedAt).toBe("2026-09-21T11:10:00.000Z");
  expect(ingestOperationId(detected[0]!.segmentId)).toBe("ingest-task-m1");
});

test("DirectConversation messages never become admitted segments", () => {
  const detected = detectAdmittedPublicChannelSegments({
    conversations: [{ id: "dm-1", workspaceId: "ws-a", channelName: null }],
    messages: [
      {
        id: "m1",
        conversationId: "dm-1",
        workspaceId: "ws-a",
        sequence: 1,
        createdAt: new Date("2026-09-21T10:00:00.000Z"),
        body: "private",
        senderKind: "human",
        senderHandle: "ada",
      },
    ],
    tasks: [
      {
        messageId: "m1",
        conversationId: "dm-1",
        workspaceId: "ws-a",
        status: "done",
        updatedAt: new Date("2026-09-21T10:05:00.000Z"),
      },
    ],
    admittedMessageIds: new Set(),
    now,
    quietAfterMs: 1,
  });
  expect(detected).toEqual([]);
});

test("source payload hash is stable for the same identified bodies", () => {
  expect(
    sourcePayloadHash([
      { id: "b", body: "y" },
      { id: "a", body: "x" },
    ]),
  ).toBe(
    sourcePayloadHash([
      { id: "a", body: "x" },
      { id: "b", body: "y" },
    ]),
  );
});

test("openviking and causal_openviking share one profile-neutral detector", async () => {
  const input = {
    conversations: [{ id: "ch-1", workspaceId: "ws-a", channelName: "eng" }],
    messages: [
      {
        id: "m1",
        conversationId: "ch-1",
        workspaceId: "ws-a",
        sequence: 1,
        createdAt: new Date("2026-09-21T10:00:00.000Z"),
        body: "standup",
        senderKind: "human" as const,
        senderHandle: "ada",
      },
    ],
    tasks: [],
    admittedMessageIds: new Set<string>(),
    now,
    quietAfterMs: 1,
  };
  const first = detectAdmittedPublicChannelSegments(input);
  const second = detectAdmittedPublicChannelSegments(input);
  expect(first).toHaveLength(1);
  expect(second).toEqual(first);
  expect(first[0]?.sourceMessageIds).toEqual(["m1"]);
  expect(first[0]?.conversationKind).toBe("public_channel");
  const detector = await Bun.file(new URL("./detect-segments.ts", import.meta.url)).text();
  expect(detector).not.toMatch(/function detectAdmittedPublicChannelSegments[\s\S]*desired/);
  const dispatch = await Bun.file(new URL("./dispatch.ts", import.meta.url)).text();
  const sweep = await Bun.file(new URL("./sweep.ts", import.meta.url)).text();
  expect(dispatch).toMatch(/detect-segments/);
  expect(sweep).toMatch(/detectAdmittedPublicChannelSegments/);
});
