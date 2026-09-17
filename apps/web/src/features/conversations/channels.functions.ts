import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "../../server/auth/function-auth";
import { PublicChannels } from "../../server/conversations/public-channels.server";
import { attachmentView } from "../../server/attachments/attachment-view.server";
import { CentrifugoConversationRealtime } from "../../server/conversations/conversation-realtime.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { bestEffortMessageNotifier } from "../../server/notifications/web-push-composition.server";
import { workspaceUserAvatarUrl } from "../../server/db/repositories/user-profile.repositories.server";

const channelInput = z.object({ channelId: z.uuid() });
const channelPageInput = channelInput.extend({
  beforeSequence: z.number().int().positive().optional(),
});
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
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.open(workspaceId, userId, data.channelId, {
      beforeSequence: data.beforeSequence,
    });
  });

export const loadPublicChannelUpdates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(channelUpdatesInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.updates(workspaceId, userId, data.channelId, data.afterSequence);
  });

export const loadPublicChannelMembers = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    return channels.members(workspaceId, userId, data.channelId);
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
    return channels.addMembers(workspaceId, userId, data.channelId, {
      userIds: data.userIds,
      agentIds: data.agentIds,
    });
  });

export const joinPublicChannel = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context }) => {
    const { channels, workspaceId, userId } = channelScope(context);
    await channels.join(workspaceId, userId, data.channelId);
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

export const sendPublicChannelMessage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    channelInput.extend({
      requestId: z.uuid(),
      body: z.string().trim().min(1).max(8_000),
      attachmentId: z.uuid().optional(),
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
      senderName: `@${username}`,
      senderAvatarUrl: workspaceUserAvatarUrl(
        workspaceId,
        userId,
        message.sender?.user?.avatarObjectKey ?? null,
      ),
      body: message.body,
      createdAt: message.createdAt,
      attachment: message.attachment ? attachmentView(message.attachment) : undefined,
      reactions: undefined,
    };
  });
