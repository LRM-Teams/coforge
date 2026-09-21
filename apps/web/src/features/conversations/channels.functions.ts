import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "../../server/auth/function-auth";
import { AppError } from "../../lib/app-error";
import { PublicChannels } from "../../server/conversations/public-channels.server";
import { attachActionCardViews } from "../../server/conversations/action-cards.server";
import { attachmentView } from "../../server/attachments/attachment-view.server";
import { attachmentIdsSchema, conversationPageInputSchema } from "./conversation.schemas";
import { CentrifugoConversationRealtime } from "../../server/conversations/conversation-realtime.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { bestEffortMessageNotifier } from "../../server/notifications/web-push-composition.server";
import { browserMessageMention } from "../../server/conversations/mentions";
import { workspaceUserAvatarUrl } from "../../server/db/repositories/user-profile.repositories.server";

const channelInput = z.object({ channelId: z.uuid() });
const channelPageInput = channelInput.extend(conversationPageInputSchema);
const channelUpdatesInput = channelInput.extend({
  afterSequence: z.number().int().nonnegative(),
});
const channelThreadReadInput = channelInput.extend({
  threadRootId: z.uuid(),
  throughSequence: z.number().int().positive(),
});
const channelThreadFollowInput = channelInput.extend({
  threadRootId: z.uuid(),
  followed: z.boolean(),
});
function channelScope({ db, workspaceId, user }: WorkspaceUserContext) {
  return {
    channels: new PublicChannels(db),
    db,
    workspaceId,
    userId: user.id,
    username: user.username,
  };
}

export const listPublicChannels = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.list(workspaceId, userId);
  });

export const createPublicChannel = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      name: z
        .string()
        .trim()
        .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
      projectId: z.uuid().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.create(workspaceId, userId, data.name, data.projectId);
  });

export const loadPublicChannel = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(channelPageInput)
  .handler(async ({ data, context }) => {
    const { channels, db, workspaceId, userId } = channelScope(context);
    const page = await channels.open(workspaceId, userId, data.channelId, {
      beforeSequence: data.beforeSequence,
      afterSequence: data.afterSequence,
      limit: data.limit,
    });
    return {
      ...page,
      messages: await attachActionCardViews(db, workspaceId, userId, page.messages),
    };
  });

export const loadPublicChannelMentionables = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.mentionDirectory(workspaceId, userId, data.channelId);
  });

export const loadPublicChannelUpdates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(channelUpdatesInput)
  .handler(async ({ data, context }) => {
    const { channels, db, workspaceId, userId } = channelScope(context);
    const messages = await channels.updates(
      workspaceId,
      userId,
      data.channelId,
      data.afterSequence,
    );
    return attachActionCardViews(db, workspaceId, userId, messages);
  });

export const loadPublicChannelMembers = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.members(workspaceId, { userId }, data.channelId);
  });

export const addPublicChannelMembers = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    channelInput.extend({
      userIds: z.array(z.uuid()).default([]),
      agentIds: z.array(z.uuid()).default([]),
    }),
  )
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.addMembers(workspaceId, { userId }, data.channelId, {
      userIds: data.userIds,
      agentIds: data.agentIds,
    });
  });

/** Promote/demote a channel member's stored `channelRole` (ADR 0030). Human-only: there is no
 * Agent CLI/API route for this. `PublicChannels.setChannelRole` enforces `manage_roles`
 * (Workspace owner/admin, or channel admin of this channel) and rejects `#general`. */
export const setPublicChannelMemberRole = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    channelInput
      .extend({
        userId: z.uuid().optional(),
        agentId: z.uuid().optional(),
        role: z.enum(["admin", "member"]),
      })
      .refine((data) => (data.userId === undefined) !== (data.agentId === undefined), {
        message: "exactly one of userId or agentId is required",
      }),
  )
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    const member = data.userId ? { userId: data.userId } : { agentId: data.agentId! };
    return channels.setChannelRole(workspaceId, userId, data.channelId, member, data.role);
  });

export const joinPublicChannel = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    await channels.join(workspaceId, userId, data.channelId);
  });

/** Marks every top-level message through `throughSequence` read for the sidebar badge. */
export const markPublicChannelRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput.extend({ throughSequence: z.number().int().positive() }))
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    await channels.markRead(workspaceId, userId, data.channelId, data.throughSequence);
  });

export const leavePublicChannel = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    await channels.leave(workspaceId, userId, data.channelId);
  });

export const removePublicChannelMember = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    channelInput.extend({
      userId: z.uuid().optional(),
      agentId: z.uuid().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    if ((data.userId === undefined) === (data.agentId === undefined))
      throw new AppError("INVALID_INPUT");
    return channels.removeMember(
      workspaceId,
      userId,
      data.channelId,
      data.userId ? { userId: data.userId } : { agentId: data.agentId! },
    );
  });

export const setPublicChannelMuted = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput.extend({ muted: z.boolean() }))
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.setUserMuted(workspaceId, userId, data.channelId, data.muted);
  });

export const markPublicChannelThreadRead = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelThreadReadInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    await channels.markThreadReadForUser(
      workspaceId,
      userId,
      data.channelId,
      data.threadRootId,
      data.throughSequence,
    );
  });

export const setPublicChannelThreadFollowed = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelThreadFollowInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.setUserThreadFollowed(
      workspaceId,
      userId,
      data.channelId,
      data.threadRootId,
      data.followed,
    );
  });

const channelThreadAgentsInput = channelInput.extend({ threadRootId: z.uuid() });

export const loadPublicChannelThreadFollowingAgents = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(channelThreadAgentsInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.threadFollowingAgents(workspaceId, userId, data.channelId, data.threadRootId);
  });

export const unfollowPublicChannelThreadAgent = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelThreadAgentsInput.extend({ agentId: z.uuid() }))
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.unfollowAgentFromThread(
      workspaceId,
      userId,
      data.channelId,
      data.threadRootId,
      data.agentId,
    );
  });

export const sendPublicChannelMessage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    channelInput.extend({
      requestId: z.uuid(),
      body: z.string().trim().min(1).max(8_000),
      attachmentIds: attachmentIdsSchema,
      threadRootId: z.uuid().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { db, workspaceId, userId, username } = channelScope(context);
    const centrifugo = createCentrifugoServerApi();
    const channels = new PublicChannels(
      db,
      undefined,
      centrifugo,
      bestEffortMessageNotifier(db),
      new CentrifugoConversationRealtime(centrifugo),
    );
    const message = await channels.send({ ...data, workspaceId, userId });
    return {
      id: message.id,
      sequence: message.sequence,
      threadRootId: message.threadRootId ?? undefined,
      senderMemberId: message.senderMemberId,
      senderKind: "user" as const,
      // The echo must read exactly like the same message after a reload: a display name, with
      // the handle carried separately (see `sender-display.server.ts`). `username` from the
      // session is the fallback when this person has set no display name.
      senderName: message.sender?.user?.displayName?.trim() || username,
      senderHandle: username,
      // A human-sent echo never carries an Agent id, and a human sender is never deleted.
      senderAgentId: undefined,
      senderDeleted: false,
      senderAvatarUrl: workspaceUserAvatarUrl(
        workspaceId,
        userId,
        message.sender?.user?.avatarObjectKey ?? null,
      ),
      body: message.body,
      createdAt: message.createdAt,
      mentions: message.mentions.map(browserMessageMention),
      attachments: message.attachments.map((attachment) => attachmentView(attachment)),
      reactions: undefined,
      // A human-sent message never carries an action card (those are Agent-authored only).
      actionCard: undefined,
    };
  });

/** The viewer's own emoji reaction on a channel message; returns the message's fresh summaries. */
export const toggleChannelMessageReaction = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    channelInput.extend({
      messageId: z.uuid(),
      emoji: z.string().min(1).max(16),
      active: z.boolean(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.toggleUserReaction(
      workspaceId,
      userId,
      data.channelId,
      data.messageId,
      data.emoji,
      data.active,
    );
  });
