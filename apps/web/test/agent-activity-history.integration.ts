import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { AgentActivityRepository } from "#src/server/db/repositories/agent-activity.repositories.server";

function testDatabase() {
  const connectionString = Bun.env.AGENT_ACTIVITY_TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error("AGENT_ACTIVITY_TEST_DATABASE_URL is required (local PostgreSQL)");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

test("compact activity history preserves launch sequence across clock rollback and authorization", async () => {
  const db = testDatabase();
  const fixture = crypto.randomUUID();
  const member = await db.user.create({
    data: { username: `activity-member-${fixture}` },
  });
  const outsider = await db.user.create({
    data: { username: `activity-outsider-${fixture}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: `activity-${fixture}`,
      name: "Activity history test",
      members: { create: { userId: member.id } },
    },
  });
  const otherWorkspace = await db.workspace.create({
    data: {
      slug: `activity-other-${fixture}`,
      name: "Other activity history test",
      members: { create: { userId: outsider.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: member.id, machineId: `activity-${fixture}` },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: member.id,
        computerId: computer.id,
        name: "clock-rollback",
        displayName: "Clock rollback",
        runtimeConfig: {},
      },
    });
    const emptyAgent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: member.id,
        name: "empty",
        displayName: "Empty",
        runtimeConfig: {},
      },
    });
    const otherAgent = await db.agent.create({
      data: {
        workspaceId: otherWorkspace.id,
        ownerId: outsider.id,
        name: "other",
        displayName: "Other",
        runtimeConfig: {},
      },
    });
    const at = (second: number) => new Date(`2026-01-01T00:00:${String(second).padStart(2, "0")}Z`);
    await db.agentActivity.createMany({
      data: [
        [agent.id, workspace.id, computer.id, "launch-a", 1, "working", 10],
        [agent.id, workspace.id, computer.id, "launch-a", 2, "working", 11],
        [agent.id, workspace.id, computer.id, "launch-a", 3, "idle", 1],
        [agent.id, workspace.id, computer.id, "launch-b", 1, "working", 9],
        [agent.id, workspace.id, computer.id, "launch-b", 2, "working", 8],
        [agent.id, workspace.id, computer.id, "launch-b", 3, "working", 7],
        [otherAgent.id, otherWorkspace.id, computer.id, "other-launch", 1, "working", 59],
      ].map(([agentId, workspaceId, computerId, launchId, clientSeq, activity, second]) => ({
        agentId: String(agentId),
        workspaceId: String(workspaceId),
        computerId: String(computerId),
        launchId: String(launchId),
        clientSeq: Number(clientSeq),
        detailKind: String(activity),
        level: "info",
        detail: "must not be selected",
        occurredAt: at(Number(second)),
        entries: [],
      })),
    });

    const repository = new AgentActivityRepository(db);
    const history = await repository.listForMember(workspace.id, member.id);
    expect(history.map(({ id }) => id).sort()).toEqual([agent.id, emptyAgent.id].sort());
    expect(history.find(({ id }) => id === emptyAgent.id)?.activity).toEqual([]);
    expect(
      history
        .find(({ id }) => id === agent.id)
        ?.activity.map(({ launchId, clientSeq, detailKind }) => [launchId, clientSeq, detailKind]),
    ).toEqual([
      ["launch-a", 3, "idle"],
      ["launch-a", 2, "working"],
      ["launch-b", 3, "working"],
      ["launch-b", 2, "working"],
      ["launch-b", 1, "working"],
    ]);
    expect(await repository.listForMember(workspace.id, outsider.id)).toEqual([]);
    expect(await repository.listForMember(otherWorkspace.id, member.id)).toEqual([]);
  } finally {
    await db.workspace.deleteMany({
      where: { id: { in: [workspace.id, otherWorkspace.id] } },
    });
    await db.computer.deleteMany({
      where: { ownerId: { in: [member.id, outsider.id] } },
    });
    await db.user.deleteMany({
      where: { id: { in: [member.id, outsider.id] } },
    });
    await db.$disconnect();
  }
});

test("compact activity history reads the five newest shown rows past hidden kinds and older launches", async () => {
  const db = testDatabase();
  const fixture = crypto.randomUUID();
  const member = await db.user.create({ data: { username: `activity-deep-${fixture}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `activity-deep-${fixture}`,
      name: "Deep activity history test",
      members: { create: { userId: member.id } },
    },
  });
  try {
    const computer = await db.computer.create({
      data: { ownerId: member.id, machineId: `activity-deep-${fixture}` },
    });
    const agent = await db.agent.create({
      data: {
        workspaceId: workspace.id,
        ownerId: member.id,
        computerId: computer.id,
        name: "deep",
        displayName: "Deep",
        runtimeConfig: {},
      },
    });
    // Three launches of 40 rows each, every other row a kind the popover hides, and the newest
    // rows of all hidden: the five shown rows sit behind them, and nothing older may surface.
    const kinds = ["tool_started", "tool_end", "thinking_started", "thinking_end"];
    await db.agentActivity.createMany({
      data: Array.from({ length: 120 }, (_, index) => ({
        agentId: agent.id,
        workspaceId: workspace.id,
        computerId: computer.id,
        launchId: `launch-${Math.floor(index / 40)}`,
        clientSeq: (index % 40) + 1,
        detailKind: index >= 116 ? "compaction_finished" : kinds[index % kinds.length]!,
        level: "info",
        detail: `row ${index}`,
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
        entries: [],
      })),
    });

    const history = await new AgentActivityRepository(db).listForMember(workspace.id, member.id);
    expect(
      history[0]?.activity.map(({ launchId, clientSeq, detailKind }) => [
        launchId,
        clientSeq,
        detailKind,
      ]),
    ).toEqual([
      ["launch-2", 35, "thinking_started"],
      ["launch-2", 33, "tool_started"],
      ["launch-2", 31, "thinking_started"],
      ["launch-2", 29, "tool_started"],
      ["launch-2", 27, "thinking_started"],
    ]);
  } finally {
    await db.workspace.deleteMany({ where: { id: workspace.id } });
    await db.computer.deleteMany({ where: { ownerId: member.id } });
    await db.user.deleteMany({ where: { id: member.id } });
    await db.$disconnect();
  }
});
