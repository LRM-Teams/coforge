import type { Prisma, PrismaClient } from "@/generated/prisma/client";

/**
 * Whether the Computer is connected to the Workspace and the User is a member of that Workspace.
 *
 * The membership filter is declared against `Prisma.WorkspaceWhereInput` on its own rather than
 * inlined under `workspace:`: nested relation filters are a union type, where TypeScript does not
 * report an unknown key, so a misspelt relation (`memberships` is the User side; the Workspace
 * side is `members`) compiled and only failed at request time as a Prisma validation error.
 */
export async function isWorkspaceMemberComputer(
  db: Pick<PrismaClient, "workspaceComputer">,
  scope: { userId: string; workspaceId: string; computerId: string },
): Promise<boolean> {
  const hasMember: Prisma.WorkspaceWhereInput = { members: { some: { userId: scope.userId } } };
  const connection = await db.workspaceComputer.findFirst({
    where: { workspaceId: scope.workspaceId, computerId: scope.computerId, workspace: hasMember },
    select: { id: true },
  });
  return Boolean(connection);
}
