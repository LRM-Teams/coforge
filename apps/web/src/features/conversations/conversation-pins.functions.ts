import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { arrangeConversationPins } from "#src/server/conversations/conversation-pins.server";

const pinRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("channel"), channelId: z.uuid() }),
  z.object({ kind: z.literal("direct"), agentId: z.uuid() }),
]);

/** Puts the viewer's pinned channels and DMs in the order a drag in the sidebar's Pinned section
 * left them, unpinning the ones dragged out. */
export const arrangePinnedConversations = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({ pins: z.array(pinRefSchema).max(500), unpinned: z.array(pinRefSchema).max(500) }),
  )
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    await arrangeConversationPins(db, workspaceId, user.id, data);
  });
