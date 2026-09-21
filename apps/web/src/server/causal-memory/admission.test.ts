import { expect, test } from "bun:test";
import { detectAdmittedSegments, ingestOperationId, sourcePayloadHash } from "./admission";

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
  const detected = detectAdmittedSegments({
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
  expect(detected.map((row) => row.ledger.kind)).toEqual(["completed_task", "quiet_window"]);
  expect(detected[0]?.ledger.sourceMessageIds).toEqual(["m1"]);
  expect(detected[1]?.ledger.sourceMessageIds).toEqual(["m2"]);
  expect(detected[0]?.ledger.operationId).toBe(ingestOperationId("task-m1"));
});

test("direct conversations and already-admitted messages never become segments", () => {
  const detected = detectAdmittedSegments({
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
    tasks: [],
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
