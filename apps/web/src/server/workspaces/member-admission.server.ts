import type { Prisma } from "#src/generated/prisma/client";
import { enrollGeneralChannel } from "#src/server/conversations/public-channels.server";
import type { WorkspaceMemberRole } from "./member-role.server";

/**
 * Someone joins the Workspace, by a join link: their membership, their
 * place in `#general`, and their direct conversations from an earlier stay active again with read
 * positions kept (the other channels they were in stay left until they join them). Runs inside the
 * caller's transaction; it reports the channels whose member lists changed so the caller can
 * announce them once the transaction commits.
 */
export async function admitWorkspaceMember(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; userId: string; role: WorkspaceMemberRole },
): Promise<{ joinedChannelIds: string[] }> {
  await tx.workspaceMembership.create({
    data: { workspaceId: input.workspaceId, userId: input.userId, role: input.role },
  });
  const general = await enrollGeneralChannel(tx, input.workspaceId);
  await tx.conversationMember.updateMany({
    where: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      leftAt: { not: null },
      conversation: { directKey: { not: null } },
    },
    data: { leftAt: null },
  });
  return { joinedChannelIds: [general.id] };
}
