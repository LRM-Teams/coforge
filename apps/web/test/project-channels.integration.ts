import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { PublicChannels } from "../src/server/conversations/public-channels.server";
import { ProjectSettings } from "../src/server/projects/project-settings.server";

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

    const settings = new ProjectSettings(db);
    await expect(
      settings.update(foreignWorkspace.id, user.id, {
        id: foreignProject.id,
        name: "Forbidden",
        description: "No access",
        commitCoAuthor: true,
      }),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      settings.update(workspace.id, user.id, {
        id: foreignProject.id,
        name: "Forbidden",
        description: "Wrong workspace",
        commitCoAuthor: true,
      }),
    ).rejects.toThrow("NOT_FOUND");
    await settings.update(workspace.id, user.id, {
      id: project.id,
      name: "Renamed launch",
      description: "Release planning",
      commitCoAuthor: true,
    });
    expect(await db.project.findUnique({ where: { id: project.id } })).toMatchObject({
      name: "Renamed launch",
      description: "Release planning",
      slug: `launch-${suffix}`,
    });

    const repository = { id: 903, installationId: 71, fullName: "team/planning" };
    const connected = new ProjectSettings(db, {
      accessibleRepositories: async (callerId) => {
        expect(callerId).toBe(user.id);
        return [{ ...repository, private: true, htmlUrl: "https://github.com/team/planning" }];
      },
    });
    const update = {
      id: project.id,
      name: "Renamed launch",
      description: "Release planning",
      commitCoAuthor: true,
    };
    for (const forged of [
      { ...repository, id: 904 },
      { ...repository, installationId: 72 },
      { ...repository, fullName: "other/planning" },
    ]) {
      await expect(
        connected.update(workspace.id, user.id, { ...update, repository: forged }),
      ).rejects.toThrow("ACCESS_DENIED");
    }
    await connected.update(workspace.id, user.id, { ...update, repository });
    // Losing GitHub access must not unlink the repository when only editing metadata.
    await settings.update(workspace.id, user.id, update);
    expect(await db.project.findUnique({ where: { id: project.id } })).toMatchObject({
      githubInstallationId: 71,
      githubRepositoryId: 903,
      githubFullName: "team/planning",
      githubHtmlUrl: "https://github.com/team/planning",
    });
    await settings.update(workspace.id, user.id, { ...update, repository: null });
    expect(await db.project.findUnique({ where: { id: project.id } })).toMatchObject({
      githubInstallationId: null,
      githubRepositoryId: null,
      githubFullName: null,
      githubHtmlUrl: null,
    });

    const message = await db.message.create({
      data: {
        conversationId: existing.id,
        workspaceId: workspace.id,
        body: "Keep this history",
        sequence: 1,
      },
    });
    await expect(settings.delete(workspace.id, user.id, project.id, "Launch")).rejects.toThrow(
      "INVALID_INPUT",
    );
    await expect(
      settings.delete(workspace.id, user.id, foreignProject.id, "Foreign"),
    ).rejects.toThrow("INVALID_INPUT");
    await expect(
      settings.delete(foreignWorkspace.id, user.id, foreignProject.id, "Foreign"),
    ).rejects.toThrow("INVALID_INPUT");
    await settings.delete(workspace.id, user.id, project.id, "Renamed launch");
    expect(await db.project.findUnique({ where: { id: project.id } })).toBeNull();
    for (const id of [existing.id, created.id]) {
      expect(
        await db.conversation.findUnique({ where: { id }, include: { members: true } }),
      ).toMatchObject({
        projectId: null,
        members: [{ userId: user.id }],
      });
    }
    expect(await db.message.findUnique({ where: { id: message.id } })).toMatchObject({
      body: "Keep this history",
    });
    expect(await db.project.findUnique({ where: { id: foreignProject.id } })).toMatchObject({
      name: "Foreign",
    });
  } finally {
    await db.workspace.deleteMany({
      where: { id: { in: [workspace.id, foreignWorkspace.id] } },
    });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
