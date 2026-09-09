import type { PrismaClient } from "../../../generated/client";

export const AGENT_REMINDER_PAGE_SIZE = 50;

export type AgentReminderViewer = { userId: string; workspaceId: string };
export type AgentReminderCursor = { id: string };

export type AgentReminderListItem = {
  id: string;
  title: string;
  fireAt: string;
  repeat: string | null;
  timezone: string | null;
  target: string;
  createdAt: string;
  anchor:
    | { kind: "direct"; agentId: string; messageId: string; threadRootId: string | null }
    | {
        kind: "channel";
        channelId: string;
        channelName: string;
        messageId: string;
        threadRootId: string | null;
      }
    | null;
};

export interface AgentReminderReadStore {
  ownsAgent(viewer: AgentReminderViewer, agentId: string): Promise<boolean>;
  list(input: {
    viewer: AgentReminderViewer;
    agentId: string;
    cursor?: AgentReminderCursor;
    take: number;
  }): Promise<AgentReminderListItem[]>;
}

export class AgentRemindersQuery {
  constructor(private readonly store: AgentReminderReadStore) {}

  async list(
    viewer: AgentReminderViewer,
    input: { agentId: string; cursor?: AgentReminderCursor },
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
    list: async ({ viewer, agentId, cursor, take }) => {
      const rows = await db.reminder.findMany({
        where: {
          workspaceId: viewer.workspaceId,
          ownerAgentId: agentId,
          ownerAgent: {
            ownerId: viewer.userId,
            workspace: { members: { some: { userId: viewer.userId } } },
          },
          status: "scheduled",
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
        take,
        select: {
          id: true,
          title: true,
          fireAt: true,
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
                channelName: conversation.channelName,
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
          fireAt: row.fireAt.toISOString(),
          repeat: row.repeat,
          timezone: row.timezone,
          target: row.target,
          createdAt: row.createdAt.toISOString(),
          anchor,
        };
      });
    },
  };
}
