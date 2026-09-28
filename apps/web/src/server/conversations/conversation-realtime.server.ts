import type { PrismaClient } from "#src/generated/prisma/client";
import {
  conversationRealtimeChannel,
  userConversationChannel,
  workspaceConversationChannel,
  type ActivityChangedEvent,
  type ChannelUpdatedEvent,
  type MessageAvailableEvent,
  type MemberChangedEvent,
} from "#src/features/conversations/conversation-realtime";
import type { TaskChangedEvent } from "#src/features/tasks/task-realtime";
import {
  createCentrifugoServerApi,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";

export type ConversationRealtimeMessage = {
  conversationId: string;
  messageId: string;
  sequence: number;
  /** The message's Workspace; scopes the workspace-level signal fan-out. */
  workspaceId?: string;
  /** Present only for a thread reply (channel unread never counts thread replies). */
  threadRootId?: string;
  /** The viewing user of a direct message; routes the event to that user's own signal channel. */
  userId?: string;
  /** Present only for a direct message: the Agent badge this event bumps. */
  agentId?: string;
  /** Present only for a person's send: its idempotency key, so the sender's page can match the
   * pending copy it shows to this message (see `MessageAvailableEvent.requestId`). */
  requestId?: string;
};

/**
 * The realtime fan-out scope for one conversation's messages. A channel message goes
 * to the Workspace signal channel; a direct message goes only to its human viewer's own channel,
 * naming the Agent badge it belongs to, so DM metadata never reaches the Workspace. A direct
 * conversation that does not have exactly one human and one Agent (unreachable through the
 * supported create path) falls back to the Workspace channel rather than silently publishing
 * nowhere.
 */
export type MessageSignalScope = { workspaceId?: string; userId?: string; agentId?: string };

export async function messageSignalScope(
  db: PrismaClient,
  conversationId: string,
  workspaceId: string,
): Promise<MessageSignalScope> {
  return (await conversationSignalScopes(db, conversationId, workspaceId)).message;
}

/**
 * Where a conversation's signals go, read once: `message` as `messageSignalScope` says, and `task`
 * for its Task announcements, which carry Task content and so never take the Workspace fallback:
 * a direct conversation without exactly one human and one Agent announces its Tasks nowhere.
 */
export async function conversationSignalScopes(
  db: PrismaClient,
  conversationId: string,
  workspaceId: string,
): Promise<{ message: MessageSignalScope; task?: MessageSignalScope }> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      channelName: true,
      // Only a direct message's members name where it goes; a channel's roster (all of
      // `#general`) is never read.
      members: {
        where: { conversation: { channelName: null } },
        select: { userId: true, agentId: true },
      },
    },
  });
  if (!conversation) return { message: { workspaceId } };
  if (conversation.channelName !== null) return { message: { workspaceId }, task: { workspaceId } };
  const userId = conversation.members.find((member) => member.userId)?.userId;
  const agentId = conversation.members.find((member) => member.agentId)?.agentId;
  return userId && agentId
    ? { message: { userId, agentId }, task: { workspaceId, userId, agentId } }
    : { message: { workspaceId } };
}

/** A Task write's announcement (`TaskChangedEvent`) with where it goes: a direct message's to
 * its human viewer (`userId` and `agentId`, from `messageSignalScope`), a channel's to the
 * Workspace. `publicationId` makes a retried write's announcement a duplicate. */
export type TaskChangedSignal = Omit<TaskChangedEvent, "type"> &
  Pick<MessageSignalScope, "userId" | "agentId"> & { publicationId: string };

export type ConversationRealtime = {
  messageAvailable(input: ConversationRealtimeMessage & { publicationId?: string }): Promise<void>;
  /** A push telling each named channel's open pages that its member list is stale. */
  memberChanged(input: { workspaceId: string; conversationIds: readonly string[] }): Promise<void>;
  /** A push telling the Workspace's sidebars and the channel's open pages that its name,
   * description or archived state changed. Optional: a port without it announces nothing. */
  channelUpdated?(input: { workspaceId: string; conversationId: string }): Promise<void>;
  /** A push telling open Tasks pages the new copies of the Tasks a write changed. Optional: a
   * port without it announces nothing. */
  taskChanged?(input: TaskChangedSignal): Promise<void>;
  /** A push telling one person's Activity inbox that it changed outside their conversations.
   * Optional: a port without it announces nothing. */
  activityChanged?(input: { workspaceId: string; userId: string }): Promise<void>;
};

export class CentrifugoConversationRealtime implements ConversationRealtime {
  constructor(private readonly centrifugo: CentrifugoServerApi) {}

  async memberChanged(input: { workspaceId: string; conversationIds: readonly string[] }) {
    // One publication per channel: each event names its own conversation, which the page checks.
    await Promise.all(
      input.conversationIds.map((conversationId) => {
        const event: MemberChangedEvent = {
          type: "member.changed.v1",
          conversationId,
          workspaceId: input.workspaceId,
        };
        return this.centrifugo.publishJson(
          conversationRealtimeChannel(conversationId),
          event,
          crypto.randomUUID(),
        );
      }),
    );
  }

  async channelUpdated(input: { workspaceId: string; conversationId: string }) {
    const event: ChannelUpdatedEvent = { type: "channel.updated.v1", ...input };
    const idempotencyKey = crypto.randomUUID();
    await Promise.all([
      this.centrifugo.publishJson(
        workspaceConversationChannel(input.workspaceId),
        event,
        idempotencyKey,
      ),
      this.centrifugo.publishJson(
        conversationRealtimeChannel(input.conversationId),
        event,
        idempotencyKey,
      ),
    ]);
  }

  async activityChanged(input: { workspaceId: string; userId: string }) {
    const event: ActivityChangedEvent = {
      type: "activity.changed.v1",
      workspaceId: input.workspaceId,
    };
    await this.centrifugo.publishJson(userConversationChannel(input.userId), event);
  }

  async taskChanged({ publicationId, userId, agentId, ...announced }: TaskChangedSignal) {
    const event: TaskChangedEvent = { type: "task.changed.v1", ...announced };
    await this.centrifugo.publishJson(
      userId && agentId
        ? userConversationChannel(userId)
        : workspaceConversationChannel(announced.workspaceId),
      event,
      publicationId,
    );
  }

  async messageAvailable(input: ConversationRealtimeMessage & { publicationId?: string }) {
    const { publicationId, ...message } = input;
    const event: MessageAvailableEvent = {
      type: "message.available.v1",
      ...message,
    };
    const idempotencyKey = publicationId ?? input.messageId;
    // The per-conversation channel drives the open conversation's reconciliation. The workspace
    // channel drives the sidebar's unread counts for every channel; a direct message instead
    // goes to its viewer's own channel, so DM metadata never reaches the whole Workspace and the
    // event can name the Agent badge directly.
    const fanOutChannel = input.userId
      ? input.agentId
        ? userConversationChannel(input.userId)
        : undefined
      : input.workspaceId
        ? workspaceConversationChannel(input.workspaceId)
        : undefined;
    await Promise.all([
      this.centrifugo.publishJson(
        conversationRealtimeChannel(input.conversationId),
        event,
        idempotencyKey,
      ),
      fanOutChannel
        ? this.centrifugo.publishJson(fanOutChannel, event, idempotencyKey)
        : Promise.resolve(),
    ]);
  }
}

/**
 * Tells the open pages of these channels that their member list changed — the composer's @-list
 * and plain-@handle labels — once the membership write has committed. Every write that changes
 * who is in a channel calls this, the way Slack sends `member_joined_channel` and Discord sends
 * `GUILD_MEMBER_ADD`, so a page never polls or waits for a refresh.
 *
 * Best effort: the write already happened, and a page that misses the signal refetches whenever
 * it (re)subscribes without replaying what it missed, or regains focus. Without an injected
 * publisher it uses the production Centrifugo one, so no write path can skip the signal by
 * leaving it unwired; that client's own deadline bounds how long the write waits.
 */
export async function announceMemberChanged(
  realtime: Pick<ConversationRealtime, "memberChanged"> | undefined,
  input: { workspaceId: string; conversationIds: readonly string[] },
): Promise<void> {
  if (input.conversationIds.length === 0) return;
  try {
    await (
      realtime ?? new CentrifugoConversationRealtime(createCentrifugoServerApi())
    ).memberChanged(input);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "conversation_realtime:member_changed_failed",
        workspace_id: input.workspaceId,
        conversation_count: input.conversationIds.length,
        error_type: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}

/**
 * Tells every open sidebar of the Workspace, and the channel's open pages, that the channel was
 * renamed, described, archived, unarchived or deleted, once the write has committed — the way Slack sends
 * `channel_rename`/`channel_archive` to every connection of a workspace and Discord sends
 * `CHANNEL_UPDATE`. Best effort like `announceMemberChanged`: a page that misses it catches up on
 * its next load or focus.
 */
export async function announceChannelUpdated(
  realtime: Pick<ConversationRealtime, "channelUpdated"> | undefined,
  input: { workspaceId: string; conversationId: string },
): Promise<void> {
  try {
    const port = realtime ?? new CentrifugoConversationRealtime(createCentrifugoServerApi());
    await port.channelUpdated?.(input);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "conversation_realtime:channel_updated_failed",
        workspace_id: input.workspaceId,
        error_type: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}

/**
 * Tells the Workspace's open Tasks pages that a deleted channel's Tasks are gone
 * (`task.changed.v1` with only `deleted`), once the delete has committed. Best effort like
 * `announceChannelUpdated`: a page that misses it drops them on its next read.
 */
export async function announceChannelTasksDeleted(
  realtime: Pick<ConversationRealtime, "taskChanged"> | undefined,
  input: { workspaceId: string; conversationId: string; deleted: string[] },
): Promise<void> {
  if (input.deleted.length === 0) return;
  try {
    const port = realtime ?? new CentrifugoConversationRealtime(createCentrifugoServerApi());
    await port.taskChanged?.({
      ...input,
      tasks: [],
      publicationId: `${input.conversationId}:channel-deleted`,
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "conversation_realtime:channel_tasks_deleted_failed",
        workspace_id: input.workspaceId,
        error_type: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}
