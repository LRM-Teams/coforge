import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { readAfterStreamPositions } from "#src/server/conversations/chat-stream-positions.server";
import { userConversationChannel } from "./conversation-realtime";
import {
  listUserSavedMessages,
  saveUserMessage,
  unsaveUserMessage,
} from "#src/server/conversations/saved-messages.server";
import { savedMessageInputSchema } from "./conversation.schemas";

/** The viewer's own bookmark on one message; idempotent, returns the resulting state. */
export const saveMessage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(savedMessageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    await saveUserMessage(db, {
      workspaceId,
      conversationId: data.conversationId,
      userId: user.id,
      messageId: data.messageId,
    });
    return { saved: true as const };
  });

/** Removes the viewer's own bookmark; succeeds whether or not a row was there. */
export const unsaveMessage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(savedMessageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    await unsaveUserMessage(db, {
      workspaceId,
      conversationId: data.conversationId,
      userId: user.id,
      messageId: data.messageId,
    });
    return { saved: false as const };
  });

/**
 * Every message the viewer saved in this Workspace, newest save first (#120's Saved view), read
 * with the position of the viewer's own signal channel, which announces each save and unsave.
 */
export const listSavedMessages = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    const { streamPositions, data } = await readAfterStreamPositions(
      [userConversationChannel(user.id)],
      () => listUserSavedMessages(db, { workspaceId, userId: user.id }),
    );
    return { streamPositions, entries: data };
  });
