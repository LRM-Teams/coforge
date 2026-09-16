import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "../../server/auth/function-auth";
import { getDatabaseClient } from "../../server/db/client.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";
import { PublicChannels } from "../../server/conversations/public-channels.server";
import { CentrifugoConversationRealtime } from "../../server/conversations/conversation-realtime.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { AppError } from "../../lib/app-error";
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
async function context(user: { id: string; username: string }) {
  const db = getDatabaseClient();
  if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
  const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
  return {
    channels: new PublicChannels(db),
    db,
    workspaceId,
    userId: user.id,
    username: user.username,
  };
}

export const listPublicChannels = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context: authContext }) => {
    const { channels, workspaceId, userId } = await context(authContext.user);
    return channels.list(workspaceId, userId);
  });

export const createPublicChannel = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      name: z
        .string()
        .trim()
        .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
      projectId: z.uuid().optional(),
    }),
  )
  .handler(async ({ data, context: authContext }) => {
    const { channels, workspaceId, userId } = await context(authContext.user);
    return channels.create(workspaceId, userId, data.name, data.projectId);
  });

export const loadPublicChannel = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(channelPageInput)
  .handler(async ({ data, context: authContext }) => {
    const { channels, workspaceId, userId } = await context(authContext.user);
    return channels.open(workspaceId, userId, data.channelId, {
      beforeSequence: data.beforeSequence,
    });
  });

export const loadPublicChannelUpdates = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(channelUpdatesInput)
  .handler(async ({ data, context: authContext }) => {
    const { channels, workspaceId, userId } = await context(authContext.user);
    return channels.updates(workspaceId, userId, data.channelId, data.afterSequence);
  });

export const joinPublicChannel = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(channelInput)
  .handler(async ({ data, context: authContext }) => {
    const { channels, workspaceId, userId } = await context(authContext.user);
    await channels.join(workspaceId, userId, data.channelId);
  });

export const setPublicChannelMuted = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(channelInput.extend({ muted: z.boolean() }))
  .handler(async ({ data, context: authContext }) => {
    const { channels, workspaceId, userId } = await context(authContext.user);
    return channels.setUserMuted(workspaceId, userId, data.channelId, data.muted);
  });

export const markPublicChannelThreadRead = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(channelThreadReadInput)
  .handler(async ({ data, context: authContext }) => {
    const { channels, workspaceId, userId } = await context(authContext.user);
    await channels.markThreadReadForUser(
      workspaceId,
      userId,
      data.channelId,
      data.threadRootId,
      data.throughSequence,
    );
  });

export const setPublicChannelThreadFollowed = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(channelThreadFollowInput)
  .handler(async ({ data, context: authContext }) => {
    const { channels, workspaceId, userId } = await context(authContext.user);
    return channels.setUserThreadFollowed(
      workspaceId,
      userId,
      data.channelId,
      data.threadRootId,
      data.followed,
    );
  });

export const sendPublicChannelMessage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    channelInput.extend({
      requestId: z.uuid(),
      body: z.string().trim().min(1).max(8_000),
      attachmentId: z.uuid().optional(),
      threadRootId: z.uuid().optional(),
    }),
  )
  .handler(async ({ data, context: authContext }) => {
    const { db, workspaceId, userId, username } = await context(authContext.user);
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
      attachment: message.attachment ?? undefined,
    };
  });
