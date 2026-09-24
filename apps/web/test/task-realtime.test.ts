import { expect, test } from "bun:test";

import { decodeTaskChangedEvent } from "#src/features/tasks/task-realtime";

/** The Tasks page reads `task.changed.v1` off channels that mostly carry message signals. */
const event = {
  type: "task.changed.v1",
  workspaceId: "w",
  conversationId: "c",
  tasks: [
    {
      messageId: "m",
      conversationId: "c",
      number: 1,
      title: "Ship",
      status: "done",
      revision: 2,
      owner: null,
    },
  ],
  deleted: ["gone"],
};

test("a Task announcement decodes, as JSON or as bytes", () => {
  expect(decodeTaskChangedEvent(event)).toEqual(event as never);
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  expect(decodeTaskChangedEvent(bytes)).toEqual(event as never);
});

test("any other publication, or a malformed announcement, is not one", () => {
  expect(
    decodeTaskChangedEvent({ type: "message.available.v1", conversationId: "c", messageId: "m" }),
  ).toBeUndefined();
  expect(decodeTaskChangedEvent({ ...event, tasks: [{ messageId: "m" }] })).toBeUndefined();
  expect(decodeTaskChangedEvent(null)).toBeUndefined();
});

test("fields the announcement does not name pass through, and unreadable bytes are not one", () => {
  const withReceipt = { ...event, tasks: [{ ...event.tasks[0], channelRef: "#general" }] };
  expect(decodeTaskChangedEvent(withReceipt)?.tasks[0]).toMatchObject({ channelRef: "#general" });
  expect(decodeTaskChangedEvent(new TextEncoder().encode("{not json"))).toBeUndefined();
});
