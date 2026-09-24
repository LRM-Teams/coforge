import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { replaceConversationPins } from "#src/server/conversations/conversation-pins.server";

const pinRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("channel"), channelId: z.uuid() }),
  z.object({ kind: z.literal("direct"), agentId: z.uuid() }),
]);

/** Replaces the viewer's pinned channels and DMs with `pins`, in that order: what a drag in the
 * sidebar's Pinned section commits. */
export const replacePinnedConversations = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ pins: z.array(pinRefSchema).max(500) }))
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    await replaceConversationPins(db, workspaceId, user.id, data.pins);
  });
