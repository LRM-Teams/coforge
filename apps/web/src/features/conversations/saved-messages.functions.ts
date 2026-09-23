import { createServerFn } from "@tanstack/react-start";

import { workspaceUserMiddleware } from "../auth/function-auth";
import {
  listUserSavedMessages,
  saveUserMessage,
  unsaveUserMessage,
} from "../../server/conversations/saved-messages.server";
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

/** Every message the viewer saved in this Workspace, newest save first (#120's Saved view). */
export const listSavedMessages = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    return listUserSavedMessages(db, { workspaceId, userId: user.id });
  });
