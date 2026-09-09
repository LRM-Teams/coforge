import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import {
  AGENT_REMINDER_HISTORY_SIZE,
  AGENT_REMINDER_PAGE_SIZE,
  AgentRemindersQuery,
  prismaAgentReminderReadStore,
  type AgentReminderReadStore,
} from "@/server/agents/agent-reminders.server";

const viewer = { userId: "user-1", workspaceId: "workspace-1" };
const item = (id: string) => ({
  id,
  title: `Reminder ${id}`,
  status: "scheduled",
  fireAt: "2026-09-10T10:00:00.000Z",
  firedAt: null,
  repeat: null,
  timezone: null,
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
    history: async () => [],
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

test("history is owner scoped, reminder scoped, and bounded", async () => {
  let received: Parameters<AgentReminderReadStore["history"]>[0] | undefined;
  const query = new AgentRemindersQuery(
    store({
      history: async (input) => {
        received = input;
        return undefined;
      },
    }),
  );
  expect(await query.history(viewer, { agentId: "agent-1", reminderId: "wrong-reminder" })).toEqual(
    { status: "unauthorized" },
  );
  expect(received).toEqual({
    viewer,
    agentId: "agent-1",
    reminderId: "wrong-reminder",
    take: AGENT_REMINDER_HISTORY_SIZE,
  });
});

test("derives readable message anchors from the canonical conversation", async () => {
  const reminder = (id: string, messageId: string) => ({
    id,
    title: id,
    status: "scheduled",
    fireAt: new Date("2026-09-10T10:00:00Z"),
    firedAt: null,
    repeat: null,
    timezone: null,
    createdAt: new Date("2026-09-09T10:00:00Z"),
    messageId,
    target: "ignored",
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
      messageId: "message-channel-reply",
      threadRootId: "channel-root",
    },
  ]);
});
