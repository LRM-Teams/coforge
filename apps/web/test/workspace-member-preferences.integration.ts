import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  PrismaWorkspaceMemberPreferencesRepository,
  WorkspaceMemberPreferences,
} from "@/server/db/repositories/workspace-member-preferences.repositories.server";

function database() {
  const connectionString = Bun.env.PREFERENCES_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("PREFERENCES_TEST_DATABASE_URL must point to local PostgreSQL");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function member(db: PrismaClient) {
  const suffix = crypto.randomUUID();
  const user = await db.user.create({ data: { username: `tab-order-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `tab-order-${suffix}`,
      name: "Tab order",
      members: { create: { userId: user.id, role: "owner" } },
    },
  });
  return { userId: user.id, workspaceId: workspace.id };
}

test("each member keeps their own tab order per Workspace, removed with the membership", async () => {
  const db = database();
  const { userId, workspaceId } = await member(db);
  try {
    const preferences = new WorkspaceMemberPreferences(
      new PrismaWorkspaceMemberPreferencesRepository(db),
    );

    expect(await preferences.getTabOrders(workspaceId, userId)).toEqual({
      conversation: [],
      agentProfile: [],
    });
    await preferences.setTabOrder(workspaceId, userId, "conversation", ["files", "chat", "tasks"]);
    await preferences.setTabOrder(workspaceId, userId, "agentProfile", ["activity", "profile"]);
    expect(await preferences.getTabOrders(workspaceId, userId)).toEqual({
      conversation: ["files", "chat", "tasks"],
      agentProfile: ["activity", "profile"],
    });

    await expect(
      Promise.resolve(
        db.$executeRaw`UPDATE "workspace_member_preferences" SET "conversationTabOrder" = ARRAY['profile']
          WHERE "workspaceId" = ${workspaceId}::uuid AND "userId" = ${userId}::uuid`,
      ),
    ).rejects.toThrow("workspace_member_preferences_conversationTabOrder_check");

    await db.workspaceMembership.delete({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    expect(await preferences.getTabOrders(workspaceId, userId)).toEqual({
      conversation: [],
      agentProfile: [],
    });
  } finally {
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  }
});
