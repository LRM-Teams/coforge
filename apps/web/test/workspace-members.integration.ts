import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { humanLabel } from "#src/lib/human-label";
import { workspaceMemberDirectory } from "#src/server/workspaces/member-directory-store.server";
import { WorkspaceMembers } from "#src/server/workspaces/members.server";

test("lists only the requested Workspace directory and denies outsiders", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  try {
    const viewer = await db.user.create({
      data: {
        username: `member-viewer-${suffix}`,
        displayName: "Directory Viewer",
        description: "Views the directory",
      },
    });
    const otherOwner = await db.user.create({
      data: {
        username: `member-owner-${suffix}`,
        displayName: "Agent Owner",
        description: "Owns the Workspace Agents",
      },
    });
    const outsider = await db.user.create({
      data: { username: `member-outsider-${suffix}`, description: "Outside member" },
    });
    const workspace = await db.workspace.create({
      data: {
        slug: `members-${suffix}`,
        name: "Member directory",
        members: { create: [{ userId: viewer.id }, { userId: otherOwner.id }] },
      },
    });
    const otherWorkspace = await db.workspace.create({
      data: {
        slug: `members-other-${suffix}`,
        name: "Other member directory",
        members: { create: { userId: outsider.id } },
      },
    });
    const computer = await db.computer.create({
      data: {
        ownerId: otherOwner.id,
        machineId: `members-${suffix}`,
        name: "owner-hostname",
        displayName: "Owner workstation",
      },
    });
    await db.workspaceComputer.create({
      data: { workspaceId: workspace.id, computerId: computer.id },
    });
    const assignedAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: otherOwner.id,
        computerId: computer.id,
        name: "assigned",
        displayName: "Assigned Agent",
        description: "Runs on the owner workstation",
        runtimeConfig: {},
      },
    });
    const unassignedAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: otherOwner.id,
        name: "unassigned",
        displayName: "Unassigned Agent",
        description: "Has no Computer",
        runtimeConfig: {},
      },
    });
    const outsideAgent = await db.agent.create({
      data: {
        workspaceId: otherWorkspace.id,
        ownerId: outsider.id,
        name: "outside",
        displayName: "Outside Agent",
        description: "Must remain isolated",
        runtimeConfig: {},
      },
    });

    const members = new WorkspaceMembers(db);
    const directory = async (userId: string) => {
      const [summary, people, agents] = await Promise.all([
        members.summary(workspace.id, userId),
        members.peoplePage(workspace.id, userId, { query: "", limit: 50 }),
        members.agentPage(workspace.id, userId, { owner: "all", query: "", limit: 50 }),
      ]);
      return {
        actorRole: summary.actorRole,
        viewerId: summary.viewerId,
        people: people.items,
        agents: agents.items,
      };
    };
    expect(await directory(viewer.id)).toEqual({
      actorRole: "member",
      viewerId: viewer.id,
      people: [
        {
          id: otherOwner.id,
          name: otherOwner.username,
          displayName: "Agent Owner",
          description: "Owns the Workspace Agents",
          avatarUrl: null,
          createdAgents: {
            total: 2,
            items: [
              { id: assignedAgent.id, displayName: "Assigned Agent", avatarUrl: null },
              { id: unassignedAgent.id, displayName: "Unassigned Agent", avatarUrl: null },
            ],
          },
        },
        {
          id: viewer.id,
          name: viewer.username,
          displayName: "Directory Viewer",
          description: "Views the directory",
          avatarUrl: null,
          createdAgents: { total: 0, items: [] },
        },
      ].sort((left, right) => left.name.localeCompare(right.name)),
      agents: [
        {
          id: assignedAgent.id,
          name: "assigned",
          displayName: "Assigned Agent",
          description: "Runs on the owner workstation",
          avatarUrl: null,
          computerId: computer.id,
          computerName: "Owner workstation",
          createdAt: assignedAgent.createdAt,
          owner: { id: otherOwner.id, displayName: "Agent Owner", avatarUrl: null },
          deletable: true,
        },
        {
          id: unassignedAgent.id,
          name: "unassigned",
          displayName: "Unassigned Agent",
          description: "Has no Computer",
          avatarUrl: null,
          computerId: null,
          computerName: null,
          createdAt: unassignedAgent.createdAt,
          owner: { id: otherOwner.id, displayName: "Agent Owner", avatarUrl: null },
          deletable: true,
        },
      ],
    });
    expect(JSON.stringify(await directory(viewer.id))).not.toContain(outsideAgent.id);
    await db.computer.update({ where: { id: computer.id }, data: { displayName: " " } });
    expect((await directory(viewer.id)).agents[0]?.computerName).toBe("owner-hostname");
    await expect(directory(outsider.id)).rejects.toThrow("ACCESS_DENIED");
  } finally {
    await db.workspace.deleteMany({
      where: { slug: { in: [`members-${suffix}`, `members-other-${suffix}`] } },
    });
    await db.computer.deleteMany({ where: { machineId: `members-${suffix}` } });
    await db.user.deleteMany({
      where: {
        username: {
          in: [`member-viewer-${suffix}`, `member-owner-${suffix}`, `member-outsider-${suffix}`],
        },
      },
    });
    await db.$disconnect();
  }
});

test("the directory lists people in the order of the names they are shown by", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  // The usernames sort amy < mia < zed; the names they are shown by sort Alice < mia < Zoe.
  const usernames = ["amy", "mia", "zed"].map((name) => `label-${name}-${suffix}`);
  try {
    const [amy, mia, zed] = await Promise.all(
      usernames.map((username, index) =>
        db.user.create({ data: { username, displayName: ["Zoe", null, "Alice"][index] } }),
      ),
    );
    const workspace = await db.workspace.create({
      data: {
        slug: `label-${suffix}`,
        name: "Label order",
        members: { create: [{ userId: amy!.id }, { userId: mia!.id }, { userId: zed!.id }] },
      },
    });

    const directory = await new WorkspaceMembers(db).directory(workspace.id, amy!.id);
    expect(directory.people.map((person) => person.name)).toEqual(["Alice", usernames[1], "Zoe"]);
  } finally {
    await db.workspace.deleteMany({ where: { slug: `label-${suffix}` } });
    await db.user.deleteMany({ where: { username: { in: usernames } } });
    await db.$disconnect();
  }
});

test("a person with a full name and no display name is listed by the full name", async () => {
  const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;
  if (!connectionString)
    throw new Error("CHANNEL_TEST_DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  // The usernames sort amy < mia < zed; the names they are shown by sort Alice < mia < Zoe:
  // amy has only a full name, zed a nickname that wins over his full name, mia neither.
  const usernames = ["amy", "mia", "zed"].map((name) => `full-${name}-${suffix}`);
  try {
    const [amy, mia, zed] = await Promise.all([
      db.user.create({ data: { username: usernames[0]!, fullName: "Zoe" } }),
      db.user.create({ data: { username: usernames[1]! } }),
      db.user.create({
        data: { username: usernames[2]!, displayName: "Alice", fullName: "Zed Person" },
      }),
    ]);
    const workspace = await db.workspace.create({
      data: {
        slug: `full-${suffix}`,
        name: "Full names",
        members: { create: [{ userId: amy!.id }, { userId: mia!.id }, { userId: zed!.id }] },
      },
    });

    const directory = await new WorkspaceMembers(db).directory(workspace.id, amy!.id);
    expect(directory.people.map((person) => person.name)).toEqual(["Alice", usernames[1], "Zoe"]);

    const listed = await workspaceMemberDirectory(db).listMembers({
      workspaceId: workspace.id,
      actorUserId: amy!.id,
    });
    expect(listed.map(humanLabel)).toEqual(["Alice", usernames[1]!, "Zoe"]);

    // The page shows the same label and finds a person by it.
    const page = await new WorkspaceMembers(db).peoplePage(workspace.id, amy!.id, {
      query: "Zoe",
      limit: 10,
    });
    expect(page.items.map((person) => person.displayName)).toEqual(["Zoe"]);
  } finally {
    await db.workspace.deleteMany({ where: { slug: `full-${suffix}` } });
    await db.user.deleteMany({ where: { username: { in: usernames } } });
    await db.$disconnect();
  }
});
