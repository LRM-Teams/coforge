import type { PrismaClient } from "../../../generated/client";
import { ConversationHistory } from "./conversation-history.server";

const noticeType = (type: string): "created" | "fired" =>
  type === "created" ? "created" : "fired";

/** Bounded reminder-event history authorized with the conversation it annotates. */
export class ReminderNotices {
  constructor(private readonly db: PrismaClient) {}

  async list(
    workspaceId: string,
    userId: string,
    conversationId: string,
    requestedThreadRootId?: string,
    requestedLimit = 40,
  ) {
    await new ConversationHistory(this.db).authorize(workspaceId, userId, conversationId);
    const limit = Math.min(Math.max(requestedLimit, 1), 50);
    const messages = await this.db.message.findMany({
      where: {
        workspaceId,
        conversationId,
        ...(requestedThreadRootId
          ? { OR: [{ id: requestedThreadRootId }, { threadRootId: requestedThreadRootId }] }
          : { threadRootId: null }),
      },
      select: { id: true },
    });
    const events = await this.db.reminderEvent.findMany({
      where: {
        workspaceId,
        type: { in: ["created", "fired"] },
        reminder: {
          is: {
            ...(requestedThreadRootId
              ? { target: { endsWith: `:${requestedThreadRootId}` } }
              : { NOT: { target: { contains: ":" } } }),
            messageId: { in: messages.map((message) => message.id) },
          },
        },
      },
      orderBy: [{ time: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        type: true,
        title: true,
        time: true,
        scheduledFor: true,
        nextFireAt: true,
        reminder: {
          select: {
            target: true,
            messageId: true,
            ownerAgent: { select: { name: true, displayName: true } },
          },
        },
      },
    });
    return {
      hasOlder: events.length > limit,
      notices: events
        .slice(0, limit)
        .reverse()
        .map((event) => ({
          id: event.id,
          type: noticeType(event.type),
          title: event.title,
          time: event.time,
          fireAt: event.scheduledFor,
          nextFireAt: event.nextFireAt,
          ownerAgentName: event.reminder.ownerAgent.displayName || event.reminder.ownerAgent.name,
          messageId: event.reminder.messageId,
          threadRootId: requestedThreadRootId,
        })),
    };
  }
}
