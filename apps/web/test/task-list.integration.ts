import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import type { TaskCommand, TaskPrincipal, TaskView } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

test("An Agent's own Task list covers its channels and DMs and says what it leaves out", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const handle = crypto.randomUUID().slice(0, 8);
  const alice = await db.user.create({ data: { username: `list-alice-${handle}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-list-${handle}`,
      name: "Task list",
      members: { create: [{ userId: alice.id, role: "owner" }] },
      agents: {
        create: {
          name: `list-agent-${handle}`,
          displayName: "List Agent",
          ownerId: alice.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents[0]!;
  const channel = (name: string) =>
    db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: `${name}-${handle}`,
        members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
      },
    });
  const work = await channel("work");
  const archived = await channel("old");
  const hidden = await channel("hidden");
  const left = await channel("left");
  await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      directKey: [alice.id, agent.id].sort().join(":"),
      members: { create: [{ userId: alice.id }, { agentId: agent.id }] },
    },
  });
  const board = new TaskBoard(db);
  const asAlice: TaskPrincipal = { workspaceId: workspace.id, userId: alice.id };
  const asAgent: TaskPrincipal = { workspaceId: workspace.id, agentId: agent.id };
  const run = (principal: TaskPrincipal, command: Omit<TaskCommand, "idempotencyKey">) =>
    board.execute(principal, { idempotencyKey: crypto.randomUUID(), ...command });
  const selfAssigned = async (target: string, title: string) =>
    (await run(asAgent, { operation: "create", target, title, assignee: `@${agent.name}` }))
      .tasks[0]!;
  const summary = (task: TaskView) => ({
    channelRef: task.channelRef,
    number: task.number,
    status: task.status,
    creator: task.creator.handle,
  });

  try {
    const reserved = (
      await run(asAlice, {
        operation: "create",
        conversationId: work.id,
        title: "Reserved for the Agent",
        assignee: `@${agent.name}`,
      })
    ).tasks[0]!;
    await run(asAlice, { operation: "create", conversationId: work.id, title: "Unassigned" });
    const started = await selfAssigned(`#${work.channelName}`, "Started by the Agent");
    const finished = await selfAssigned(`#${work.channelName}`, "Finished");
    await run(asAgent, {
      operation: "update",
      target: `#${work.channelName}`,
      number: finished.number,
      status: "done",
    });
    const inDirect = await selfAssigned(`@${alice.username}`, "Direct work");
    const inArchived = await selfAssigned(`#${archived.channelName}`, "Archived work");
    await selfAssigned(`#${hidden.channelName}`, "Hidden work");
    await selfAssigned(`#${left.channelName}`, "Work in a channel the Agent left");
    await db.conversation.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    await db.conversation.update({
      where: { id: hidden.id },
      data: { hiddenFromWorkspaceAt: new Date() },
    });
    await db.conversationMember.updateMany({
      where: { conversationId: left.id, agentId: agent.id },
      data: { leftAt: new Date() },
    });

    const mine = await run(asAgent, { operation: "list", mine: true });
    expect(
      mine.tasks.map(summary).sort((a, b) => a.channelRef!.localeCompare(b.channelRef!)),
    ).toEqual(
      [
        {
          channelRef: `#${archived.channelName}`,
          number: inArchived.number,
          status: "in_progress" as const,
          creator: agent.name,
        },
        {
          channelRef: `#${work.channelName}`,
          number: reserved.number,
          status: "todo" as const,
          creator: alice.username,
        },
        {
          channelRef: `#${work.channelName}`,
          number: started.number,
          status: "in_progress" as const,
          creator: agent.name,
        },
        {
          channelRef: `@${alice.username}`,
          number: inDirect.number,
          status: "in_progress" as const,
          creator: agent.name,
        },
      ].sort((a, b) => a.channelRef.localeCompare(b.channelRef) || a.number - b.number),
    );
    for (const task of mine.tasks) {
      expect(task.createdAt).toMatch(ISO);
      expect(task.updatedAt).toMatch(ISO);
      expect(Date.parse(task.updatedAt)).toBeGreaterThanOrEqual(Date.parse(task.createdAt));
    }
    // The list is complete for what the query reads; it asserts nothing about conversations the
    // Agent is not in or that are hidden from the Workspace.
    expect(mine.coverage).toEqual({
      status: "incomplete",
      visibleConversationKinds: ["channel", "dm"],
      includesArchived: true,
      inaccessibleScope: "not_asserted",
      reason: expect.stringContaining("member"),
    });
    expect(mine.pagination).toEqual({ mode: "complete", truncated: false });

    const all = await run(asAgent, { operation: "list", mine: true, status: "all" });
    expect(all.tasks.map((task) => task.number)).toContain(finished.number);
    expect(all.tasks).toHaveLength(5);
    const done = await run(asAgent, { operation: "list", mine: true, status: "done" });
    expect(done.tasks.map(summary)).toEqual([
      {
        channelRef: `#${work.channelName}`,
        number: finished.number,
        status: "done",
        creator: agent.name,
      },
    ]);

    // A conversation's board names each Task's creator, marks one who has left, and carries the
    // Task's timestamps; only the Agent's own list describes its coverage.
    await db.conversationMember.updateMany({
      where: { conversationId: work.id, userId: alice.id },
      data: { leftAt: new Date() },
    });
    const boardList = await run(asAgent, { operation: "list", target: `#${work.channelName}` });
    expect(
      boardList.tasks.map((task) => ({
        number: task.number,
        creator: task.creator.handle,
        left: task.creator.left,
      })),
    ).toEqual([
      { number: reserved.number, creator: alice.username, left: true },
      { number: reserved.number + 1, creator: alice.username, left: true },
      { number: started.number, creator: agent.name, left: undefined },
      { number: finished.number, creator: agent.name, left: undefined },
    ]);
    expect(boardList.tasks[0]!.createdAt).toMatch(ISO);
    expect(boardList.coverage).toBeUndefined();
    expect(boardList.pagination).toBeUndefined();
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.delete({ where: { id: alice.id } });
    await db.$disconnect();
  }
});
