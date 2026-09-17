import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "../../server/auth/function-auth";
import { ActionCards } from "../../server/conversations/action-cards.server";
import { CentrifugoConversationRealtime } from "../../server/conversations/conversation-realtime.server";
import { createCentrifugoServerApi } from "../../server/centrifugo/server-api.server";

/**
 * Human commit/cancel Server Functions for Agent-prepared action cards (ADR 0027 "Commit and
 * cancel"). `channel:create` and `channel:add_member` commit here, reusing `PublicChannels`
 * through `ActionCards`. `agent:create` commits through the existing `createAgent` Server
 * Function in `agents.functions.ts` instead (it already submits the human's full runtime form and
 * enforces `assertCanCreateAgents`); this module only guards it before and marks it after — see
 * `agents.functions.ts#createAgent`.
 */

function actionCards(db: ConstructorParameters<typeof ActionCards>[0]) {
  const centrifugo = createCentrifugoServerApi();
  return new ActionCards(db, undefined, new CentrifugoConversationRealtime(centrifugo));
}

const messageIdInput = z.object({ messageId: z.uuid() });

const commitChannelCreateInput = messageIdInput.extend({
  name: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  projectId: z.uuid().optional(),
  memberUserIds: z.array(z.uuid()).default([]),
  memberAgentIds: z.array(z.uuid()).default([]),
});

const commitChannelAddMemberInput = messageIdInput.extend({
  channelId: z.uuid(),
  userIds: z.array(z.uuid()).default([]),
  agentIds: z.array(z.uuid()).default([]),
});

export const commitChannelCreateActionCard = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(commitChannelCreateInput)
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    return actionCards(db).commitChannelCreate(
      { workspaceId, actorUserId: user.id },
      {
        messageId: data.messageId,
        name: data.name,
        projectId: data.projectId,
        memberUserIds: data.memberUserIds,
        memberAgentIds: data.memberAgentIds,
      },
    );
  });

export const commitChannelAddMemberActionCard = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(commitChannelAddMemberInput)
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    return actionCards(db).commitChannelAddMember(
      { workspaceId, actorUserId: user.id },
      {
        messageId: data.messageId,
        channelId: data.channelId,
        userIds: data.userIds,
        agentIds: data.agentIds,
      },
    );
  });

export const cancelActionCard = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(messageIdInput)
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    await actionCards(db).cancel({ workspaceId, actorUserId: user.id }, data.messageId);
  });

/** Refreshes just the pending cards currently shown in an open conversation: called on a
 * realtime signal for that conversation and on window focus (see `use-conversation-view.ts`'s
 * caller in `direct-conversation.tsx`/`channel-conversation.tsx`), instead of re-fetching the
 * whole message page. */
export const loadActionCardStates = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ messageIds: z.array(z.uuid()).max(200) }))
  .handler(async ({ data, context: { db, workspaceId, user } }) => {
    const views = await new ActionCards(db).viewsFor(workspaceId, user.id, data.messageIds);
    return Object.fromEntries(views);
  });
