import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { PublicChannels } from "../src/server/conversations/public-channels.server";

test("one project owns multiple discussion channels without crossing Workspace boundaries", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const user = await db.user.create({ data: { username: `project-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `project-${suffix}`,
      name: "Project discussions",
      members: { create: { userId: user.id } },
    },
  });
  const foreignWorkspace = await db.workspace.create({
    data: { slug: `foreign-${suffix}`, name: "Foreign project workspace" },
  });

  try {
    const project = await db.project.create({
      data: { workspaceId: workspace.id, name: "Launch", slug: `launch-${suffix}` },
    });
    const foreignProject = await db.project.create({
      data: {
        workspaceId: foreignWorkspace.id,
        name: "Foreign",
        slug: `foreign-${suffix}`,
      },
    });
    const existing = await db.conversation.create({
      data: {
        workspaceId: workspace.id,
        projectId: project.id,
        channelName: `existing-${suffix.slice(0, 8)}`,
        members: { create: { userId: user.id } },
      },
      select: { id: true },
    });
    const channels = new PublicChannels(db);

    const created = await channels.create(
      workspace.id,
      user.id,
      `new-${suffix.slice(0, 8)}`,
      project.id,
    );
    const listed = await channels.list(workspace.id, user.id);
    expect(listed.map(({ id }) => id)).toEqual(expect.arrayContaining([existing.id, created.id]));
    expect((await channels.open(workspace.id, user.id, existing.id)).project?.id).toBe(project.id);
    expect((await channels.open(workspace.id, user.id, created.id)).project?.id).toBe(project.id);

    await expect(
      channels.create(workspace.id, user.id, `foreign-${suffix.slice(0, 8)}`, foreignProject.id),
    ).rejects.toThrow("INVALID_INPUT");
  } finally {
    await db.workspace.deleteMany({
      where: { id: { in: [workspace.id, foreignWorkspace.id] } },
    });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
