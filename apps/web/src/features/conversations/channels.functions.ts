import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";
import { PublicChannels } from "../../server/conversations/public-channels.server";
import { CentrifugoConversationRealtime } from "../../server/conversations/conversation-realtime.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";
import { AppError } from "../../lib/app-error";
import { bestEffortMessageNotifier } from "../../server/notifications/web-push-composition.server";

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
async function context() {
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
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

export const listPublicChannels = createServerFn({ method: "GET" }).handler(async () => {
  const { channels, workspaceId, userId } = await context();
  return channels.list(workspaceId, userId);
});

export const createPublicChannel = createServerFn({ method: "POST" })
  .validator(
    z.object({
      name: z
        .string()
        .trim()
        .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
    }),
  )
  .handler(async ({ data }) => {
    const { channels, workspaceId, userId } = await context();
    return channels.create(workspaceId, userId, data.name);
  });

export const loadPublicChannel = createServerFn({ method: "GET" })
  .validator(channelPageInput)
  .handler(async ({ data }) => {
    const { channels, workspaceId, userId } = await context();
    return channels.open(workspaceId, userId, data.channelId, {
      beforeSequence: data.beforeSequence,
    });
  });

export const loadPublicChannelUpdates = createServerFn({ method: "GET" })
  .validator(channelUpdatesInput)
  .handler(async ({ data }) => {
    const { channels, workspaceId, userId } = await context();
    return channels.updates(workspaceId, userId, data.channelId, data.afterSequence);
  });

export const joinPublicChannel = createServerFn({ method: "POST" })
  .validator(channelInput)
  .handler(async ({ data }) => {
    const { channels, workspaceId, userId } = await context();
    await channels.join(workspaceId, userId, data.channelId);
  });

export const setPublicChannelMuted = createServerFn({ method: "POST" })
  .validator(channelInput.extend({ muted: z.boolean() }))
  .handler(async ({ data }) => {
    const { channels, workspaceId, userId } = await context();
    return channels.setUserMuted(workspaceId, userId, data.channelId, data.muted);
  });

export const markPublicChannelThreadRead = createServerFn({ method: "POST" })
  .validator(channelThreadReadInput)
  .handler(async ({ data }) => {
    const { channels, workspaceId, userId } = await context();
    await channels.markThreadReadForUser(
      workspaceId,
      userId,
      data.channelId,
      data.threadRootId,
      data.throughSequence,
    );
  });

export const setPublicChannelThreadFollowed = createServerFn({ method: "POST" })
  .validator(channelThreadFollowInput)
  .handler(async ({ data }) => {
    const { channels, workspaceId, userId } = await context();
    return channels.setUserThreadFollowed(
      workspaceId,
      userId,
      data.channelId,
      data.threadRootId,
      data.followed,
    );
  });

export const sendPublicChannelMessage = createServerFn({ method: "POST" })
  .validator(
    channelInput.extend({
      requestId: z.uuid(),
      body: z.string().trim().min(1).max(8_000),
      attachmentId: z.uuid().optional(),
      threadRootId: z.uuid().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { db, workspaceId, userId, username } = await context();
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
      body: message.body,
      createdAt: message.createdAt,
      attachment: message.attachment ?? undefined,
    };
  });
