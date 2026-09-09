import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { ReminderNotices } from "../src/server/conversations/reminder-notices.server";

const authorized = {
  workspaceMembership: { findUnique: async () => ({ userId: "user-1" }) },
  conversation: {
    findFirst: async () => ({ directKey: null, channelName: "general", members: [] }),
  },
  message: { findMany: async () => [{ id: "message-1" }] },
};

describe("ReminderNotices", () => {
  test("returns bounded created and fired notices anchored to the exact main conversation", async () => {
    const eventQueries: object[] = [];
    const db = {
      ...authorized,
      reminderEvent: {
        findMany: async (input: object) => {
          eventQueries.push(input);
          return [
            {
              id: "event-1",
              type: "created",
              title: "Original launch notes",
              time: new Date("2026-09-08T10:00:00Z"),
              scheduledFor: new Date("2026-09-09T09:00:00Z"),
              nextFireAt: new Date("2026-09-09T10:00:00Z"),
              reminder: {
                title: "Review launch notes",
                target: "#general",
                messageId: "message-1",
                ownerAgent: { name: "river", displayName: "River" },
              },
            },
          ];
        },
      },
    } as unknown as PrismaClient;

    const notices = await new ReminderNotices(db).list("workspace-1", "user-1", "conversation-1");

    expect(eventQueries[0]).toMatchObject({
      where: {
        workspaceId: "workspace-1",
        type: { in: ["created", "fired"] },
        reminder: {
          is: {
            NOT: { target: { contains: ":" } },
            messageId: { in: ["message-1"] },
          },
        },
      },
      orderBy: [{ time: "desc" }, { id: "desc" }],
      take: 41,
    });
    expect(notices).toEqual({
      hasOlder: false,
      notices: [
        {
          id: "event-1",
          type: "created",
          title: "Original launch notes",
          time: new Date("2026-09-08T10:00:00Z"),
          fireAt: new Date("2026-09-09T09:00:00Z"),
          nextFireAt: new Date("2026-09-09T10:00:00Z"),
          ownerAgentName: "River",
          messageId: "message-1",
          threadRootId: undefined,
        },
      ],
    });
  });

  test("queries thread notices through the exact conversation, root, and target suffix", async () => {
    const eventQueries: object[] = [];
    const db = {
      ...authorized,
      message: { findMany: async () => [{ id: "reply-anchor" }] },
      reminderEvent: {
        findMany: async (input: object) => {
          eventQueries.push(input);
          return [event("thread", "@river:11111111-1111-4111-8111-111111111111", "reply-anchor")];
        },
      },
    } as unknown as PrismaClient;
    const notices = new ReminderNotices(db);

    expect(
      (
        await notices.list(
          "workspace-1",
          "user-1",
          "conversation-1",
          "11111111-1111-4111-8111-111111111111",
        )
      ).notices,
    ).toEqual([expect.objectContaining({ id: "thread" })]);
    expect(eventQueries[0]).toMatchObject({
      where: {
        reminder: {
          is: {
            target: { endsWith: ":11111111-1111-4111-8111-111111111111" },
            messageId: { in: ["reply-anchor"] },
          },
        },
      },
      take: 41,
    });
  });
});

function event(id: string, target: string, messageId: string) {
  return {
    id,
    type: "fired",
    title: `${id} snapshot`,
    time: new Date("2026-09-08T11:00:00Z"),
    scheduledFor: new Date("2026-09-08T10:00:00Z"),
    nextFireAt: null,
    reminder: {
      title: id,
      target,
      messageId,
      ownerAgent: { name: "river", displayName: "River" },
    },
  };
}
