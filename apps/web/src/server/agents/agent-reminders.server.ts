import type { PrismaClient } from "../../../generated/client";

export const AGENT_REMINDER_PAGE_SIZE = 50;
export const AGENT_REMINDER_HISTORY_SIZE = 20;

export type AgentReminderViewer = { userId: string; workspaceId: string };
export type AgentReminderCursor = { id: string };
export type AgentReminderStatus = "scheduled" | "fired" | "canceled";

export type AgentReminderListItem = {
  id: string;
  title: string;
  status: string;
  fireAt: string;
  firedAt: string | null;
  repeat: string | null;
  timezone: string | null;
  createdAt: string;
  anchor:
    | { kind: "direct"; agentId: string; messageId: string; threadRootId: string | null }
    | { kind: "channel"; channelId: string; messageId: string; threadRootId: string | null }
    | null;
};

export type AgentReminderHistoryItem = {
  id: string;
  type: string;
  title: string;
  time: string;
  scheduledFor: string;
  nextFireAt: string | null;
};

export interface AgentReminderReadStore {
  ownsAgent(viewer: AgentReminderViewer, agentId: string): Promise<boolean>;
  list(input: {
    viewer: AgentReminderViewer;
    agentId: string;
    status?: AgentReminderStatus;
    cursor?: AgentReminderCursor;
    take: number;
  }): Promise<AgentReminderListItem[]>;
  history(input: {
    viewer: AgentReminderViewer;
    agentId: string;
    reminderId: string;
    take: number;
  }): Promise<AgentReminderHistoryItem[] | undefined>;
}

export class AgentRemindersQuery {
  constructor(private readonly store: AgentReminderReadStore) {}

  async list(
    viewer: AgentReminderViewer,
    input: { agentId: string; status?: AgentReminderStatus; cursor?: AgentReminderCursor },
  ) {
    if (!(await this.store.ownsAgent(viewer, input.agentId)))
      return { status: "unauthorized" as const };
    const rows = await this.store.list({
      viewer,
      ...input,
      take: AGENT_REMINDER_PAGE_SIZE + 1,
    });
    const hasMore = rows.length > AGENT_REMINDER_PAGE_SIZE;
    const reminders = rows.slice(0, AGENT_REMINDER_PAGE_SIZE);
    return {
      status: "ready" as const,
      reminders,
      hasMore,
      cursor: hasMore ? { id: reminders.at(-1)!.id } : null,
    };
  }

  async history(viewer: AgentReminderViewer, input: { agentId: string; reminderId: string }) {
    if (!(await this.store.ownsAgent(viewer, input.agentId)))
      return { status: "unauthorized" as const };
    const events = await this.store.history({
      viewer,
      ...input,
      take: AGENT_REMINDER_HISTORY_SIZE,
    });
    return events ? { status: "ready" as const, events } : { status: "unauthorized" as const };
  }
}

export function prismaAgentReminderReadStore(db: PrismaClient): AgentReminderReadStore {
  return {
    ownsAgent: async (viewer, agentId) =>
      Boolean(
        await db.agent.findFirst({
          where: {
            id: agentId,
            workspaceId: viewer.workspaceId,
            ownerId: viewer.userId,
            workspace: { members: { some: { userId: viewer.userId } } },
          },
          select: { id: true },
        }),
      ),
    list: async ({ viewer, agentId, status, cursor, take }) => {
      const rows = await db.reminder.findMany({
        where: {
          workspaceId: viewer.workspaceId,
          ownerAgentId: agentId,
          ownerAgent: {
            ownerId: viewer.userId,
            workspace: { members: { some: { userId: viewer.userId } } },
          },
          ...(status ? { status } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
        take,
        select: {
          id: true,
          title: true,
          status: true,
          fireAt: true,
          firedAt: true,
          repeat: true,
          timezone: true,
          createdAt: true,
          messageId: true,
          target: true,
        },
      });
      const messages = await db.message.findMany({
        where: {
          workspaceId: viewer.workspaceId,
          id: { in: rows.map((row) => row.messageId) },
        },
        select: {
          id: true,
          threadRootId: true,
          conversation: {
            select: {
              id: true,
              channelName: true,
              members: { select: { userId: true, agentId: true } },
            },
          },
        },
      });
      const messagesById = new Map(messages.map((message) => [message.id, message]));
      return rows.map((row) => {
        const message = messagesById.get(row.messageId);
        const conversation = message?.conversation;
        const anchor =
          message && conversation?.channelName
            ? {
                kind: "channel" as const,
                channelId: conversation.id,
                messageId: row.messageId,
                threadRootId: message.threadRootId,
              }
            : message &&
                conversation?.members.some((member) => member.userId === viewer.userId) &&
                conversation.members.some((member) => member.agentId === agentId)
              ? {
                  kind: "direct" as const,
                  agentId,
                  messageId: row.messageId,
                  threadRootId: message.threadRootId,
                }
              : null;
        return {
          id: row.id,
          title: row.title,
          status: row.status,
          fireAt: row.fireAt.toISOString(),
          firedAt: row.firedAt?.toISOString() ?? null,
          repeat: row.repeat,
          timezone: row.timezone,
          createdAt: row.createdAt.toISOString(),
          anchor,
        };
      });
    },
    history: async ({ viewer, agentId, reminderId, take }) => {
      const reminder = await db.reminder.findFirst({
        where: {
          id: reminderId,
          workspaceId: viewer.workspaceId,
          ownerAgentId: agentId,
          ownerAgent: {
            ownerId: viewer.userId,
            workspace: { members: { some: { userId: viewer.userId } } },
          },
        },
        select: {
          events: {
            orderBy: [{ time: "desc" }, { id: "desc" }],
            take,
            select: {
              id: true,
              type: true,
              title: true,
              time: true,
              scheduledFor: true,
              nextFireAt: true,
            },
          },
        },
      });
      return reminder?.events.map((event) => ({
        id: event.id,
        type: event.type,
        title: event.title,
        time: event.time.toISOString(),
        scheduledFor: event.scheduledFor.toISOString(),
        nextFireAt: event.nextFireAt?.toISOString() ?? null,
      }));
    },
  };
}
