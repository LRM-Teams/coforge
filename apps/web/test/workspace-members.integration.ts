import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { WorkspaceMembers } from "../src/server/workspaces/members.server";

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
    expect(await members.list(workspace.id, viewer.id)).toEqual({
      people: [
        {
          id: otherOwner.id,
          name: otherOwner.username,
          displayName: "Agent Owner",
          description: "Owns the Workspace Agents",
        },
        {
          id: viewer.id,
          name: viewer.username,
          displayName: "Directory Viewer",
          description: "Views the directory",
        },
      ].sort((left, right) => left.name.localeCompare(right.name)),
      agents: [
        {
          id: assignedAgent.id,
          name: "assigned",
          displayName: "Assigned Agent",
          description: "Runs on the owner workstation",
          computerName: "Owner workstation",
        },
        {
          id: unassignedAgent.id,
          name: "unassigned",
          displayName: "Unassigned Agent",
          description: "Has no Computer",
          computerName: null,
        },
      ],
    });
    expect(JSON.stringify(await members.list(workspace.id, viewer.id))).not.toContain(
      outsideAgent.id,
    );
    await db.computer.update({ where: { id: computer.id }, data: { displayName: " " } });
    expect((await members.list(workspace.id, viewer.id)).agents[0]?.computerName).toBe(
      "owner-hostname",
    );
    await expect(members.list(workspace.id, outsider.id)).rejects.toThrow("ACCESS_DENIED");
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
