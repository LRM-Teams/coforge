import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import {
  AGENT_REMINDER_PAGE_SIZE,
  AgentRemindersQuery,
  prismaAgentReminderReadStore,
  type AgentReminderReadStore,
} from "@/server/agents/agent-reminders.server";

const viewer = { userId: "user-1", workspaceId: "workspace-1" };
const item = (id: string) => ({
  id,
  title: `Reminder ${id}`,
  fireAt: "2026-09-10T10:00:00.000Z",
  repeat: null,
  timezone: null,
  target: "@owner",
  createdAt: "2026-09-09T10:00:00.000Z",
  anchor: {
    kind: "direct" as const,
    agentId: "agent-1",
    messageId: "message-1",
    threadRootId: null,
  },
});

function store(overrides: Partial<AgentReminderReadStore> = {}): AgentReminderReadStore {
  return {
    ownsAgent: async () => true,
    list: async () => [],
    ...overrides,
  };
}

test("does not query reminders when the viewer does not own the Agent in the Workspace", async () => {
  let read = false;
  const query = new AgentRemindersQuery(
    store({
      ownsAgent: async () => false,
      list: async () => {
        read = true;
        return [];
      },
    }),
  );
  expect(await query.list(viewer, { agentId: "other-agent" })).toEqual({ status: "unauthorized" });
  expect(read).toBeFalse();
});

test("returns a bounded page and stable explicit cursor", async () => {
  let take = 0;
  const query = new AgentRemindersQuery(
    store({
      list: async (input) => {
        take = input.take;
        return Array.from({ length: 51 }, (_, index) => item(`id-${index}`));
      },
    }),
  );
  const result = await query.list(viewer, { agentId: "agent-1" });
  expect(take).toBe(AGENT_REMINDER_PAGE_SIZE + 1);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("expected ready result");
  expect(result.reminders).toHaveLength(50);
  expect(result.cursor).toEqual({ id: "id-49" });
  expect(result.hasMore).toBeTrue();
});

test("exposes targets and derives readable message anchors from the canonical conversation", async () => {
  const reminder = (id: string, messageId: string) => ({
    id,
    title: id,
    fireAt: new Date("2026-09-10T10:00:00Z"),
    repeat: null,
    timezone: null,
    createdAt: new Date("2026-09-09T10:00:00Z"),
    messageId,
    target: id === "public-channel" ? "#general" : "@owner",
  });
  const db = {
    reminder: {
      findMany: async () => [
        reminder("owned-dm", "message-owned-dm"),
        reminder("other-dm", "message-other-dm"),
        reminder("public-channel", "message-channel-reply"),
      ],
    },
    message: {
      findMany: async () => [
        {
          id: "message-owned-dm",
          threadRootId: null,
          conversation: {
            id: "owned-conversation",
            channelName: null,
            members: [
              { userId: "user-1", agentId: null },
              { userId: null, agentId: "agent-1" },
            ],
          },
        },
        {
          id: "message-other-dm",
          threadRootId: null,
          conversation: {
            id: "other-conversation",
            channelName: null,
            members: [
              { userId: "user-2", agentId: null },
              { userId: null, agentId: "agent-1" },
            ],
          },
        },
        {
          id: "message-channel-reply",
          threadRootId: "channel-root",
          conversation: {
            id: "channel-1",
            channelName: "general",
            members: [],
          },
        },
      ],
    },
  } as unknown as PrismaClient;

  const rows = await prismaAgentReminderReadStore(db).list({
    viewer,
    agentId: "agent-1",
    take: 50,
  });
  expect(rows.map((row) => row.anchor)).toEqual([
    {
      kind: "direct",
      agentId: "agent-1",
      messageId: "message-owned-dm",
      threadRootId: null,
    },
    null,
    {
      kind: "channel",
      channelId: "channel-1",
      channelName: "general",
      messageId: "message-channel-reply",
      threadRootId: "channel-root",
    },
  ]);
  expect(rows.map((row) => row.target)).toEqual(["@owner", "@owner", "#general"]);
  expect(rows[2]?.anchor).toMatchObject({ channelName: "general" });
});

test("filters scheduled reminders in the database before cursor pagination", async () => {
  const seeded = [
    { id: "future", status: "scheduled", fireAt: new Date("2026-09-10T10:00:00Z"), firedAt: null },
    {
      id: "recurring",
      status: "scheduled",
      fireAt: new Date("2026-09-10T11:00:00Z"),
      firedAt: new Date("2026-09-09T11:00:00Z"),
    },
    { id: "overdue", status: "scheduled", fireAt: new Date("2026-09-08T10:00:00Z"), firedAt: null },
    { id: "fired", status: "fired", fireAt: new Date("2026-09-07T10:00:00Z"), firedAt: null },
    { id: "canceled", status: "canceled", fireAt: new Date("2026-09-06T10:00:00Z"), firedAt: null },
  ];
  let findManyInput: Record<string, unknown> | undefined;
  const db = {
    reminder: {
      findMany: async (input: {
        where: { status: string };
        cursor: { id: string };
        skip: number;
        take: number;
      }) => {
        findManyInput = input;
        return seeded
          .filter((row) => row.status === input.where.status)
          .slice(0, input.take)
          .map((row) => ({
            ...row,
            title: row.id,
            repeat: row.id === "recurring" ? "daily@09:30" : null,
            timezone: null,
            createdAt: row.fireAt,
            messageId: `message-${row.id}`,
            target: "ignored",
          }));
      },
    },
    message: { findMany: async () => [] },
  } as unknown as PrismaClient;

  const rows = await prismaAgentReminderReadStore(db).list({
    viewer,
    agentId: "agent-1",
    cursor: { id: "before-50" },
    take: 50,
  });

  if (!findManyInput) throw new Error("expected the reminder query");
  expect((findManyInput.where as { status?: string }).status).toBe("scheduled");
  expect(findManyInput.cursor).toEqual({ id: "before-50" });
  expect(findManyInput.skip).toBe(1);
  expect(findManyInput.take).toBe(50);
  expect(rows.map((row) => row.id)).toEqual(["future", "recurring", "overdue"]);
});
