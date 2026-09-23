import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import type { TaskHistoryEvent } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

const eventShape = ({ seq, eventType, actorType, actorName, payload }: TaskHistoryEvent) => ({
  seq,
  eventType,
  actorType,
  actorName,
  payload,
});

test("Task changes record history events with their before and after state", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const suffix = crypto.randomUUID();
  const handle = suffix.slice(0, 8);
  const alice = await db.user.create({
    data: { username: `history-alice-${handle}`, displayName: "Alice" },
  });
  const bob = await db.user.create({ data: { username: `history-bob-${handle}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `task-history-${suffix}`,
      name: "Task history",
      members: {
        create: [
          { userId: alice.id, role: "owner" },
          { userId: bob.id, role: "member" },
        ],
      },
      agents: {
        create: {
          name: `history-agent-${handle}`,
          displayName: "History Agent",
          ownerId: alice.id,
          runtimeConfig: {},
        },
      },
    },
    include: { agents: true },
  });
  const agent = workspace.agents[0]!;
  const channel = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      channelName: `history-${handle}`,
      members: {
        create: [{ userId: alice.id }, { userId: bob.id }, { agentId: agent.id }],
      },
    },
    include: { members: true },
  });
  const board = new TaskBoard(db);
  const asAlice = { workspaceId: workspace.id, userId: alice.id };
  const asBob = { workspaceId: workspace.id, userId: bob.id };
  const asAgent = { workspaceId: workspace.id, agentId: agent.id };
  const inChannel = { conversationId: channel.id };
  const run = (principal: typeof asAlice | typeof asAgent, command: Record<string, unknown>) =>
    board.execute(principal, {
      idempotencyKey: crypto.randomUUID(),
      ...("agentId" in principal ? { target: `#${channel.channelName}` } : inChannel),
      ...command,
    } as Parameters<TaskBoard["execute"]>[1]);
  const byAlice = { actorType: "user", actorName: alice.username } as const;
  const byBob = { actorType: "user", actorName: bob.username } as const;
  const byAgent = { actorType: "agent", actorName: agent.name } as const;
  const history = async (number: number) =>
    (await run(asAlice, { operation: "history", number })).history!.map(eventShape);

  try {
    const created = await run(asAlice, {
      operation: "create",
      title: "Ship history",
      assignee: `@${bob.username}`,
    });
    const task = created.tasks[0]!;
    await run(asBob, { operation: "update", number: task.number, status: "in_progress" });
    await run(asBob, { operation: "update", number: task.number, status: "in_progress" });
    await run(asBob, { operation: "update", number: task.number, status: "in_review" });
    await run(asAlice, {
      operation: "amend",
      number: task.number,
      title: "Ship task history",
    });
    await run(asAlice, { operation: "update", number: task.number, status: "done" });
    await run(asAlice, { operation: "unassign", number: task.number });

    expect(await history(task.number)).toEqual([
      {
        seq: 1,
        eventType: "created",
        ...byAlice,
        payload: { taskNumber: task.number, status: "todo" },
      },
      {
        seq: 2,
        eventType: "assignee_changed",
        ...byAlice,
        payload: { assigneeId: bob.id, assigneeType: "user" },
      },
      {
        seq: 3,
        eventType: "status_changed",
        ...byBob,
        payload: { from: "todo", to: "in_progress" },
      },
      {
        seq: 4,
        eventType: "status_changed",
        ...byBob,
        payload: { from: "in_progress", to: "in_review" },
      },
      {
        seq: 5,
        eventType: "amended",
        ...byAlice,
        payload: {
          changes: { title: { from: "Ship history", to: "Ship task history" } },
          revision: 4,
        },
      },
      {
        seq: 6,
        eventType: "status_changed",
        ...byAlice,
        payload: { from: "in_review", to: "done" },
      },
      {
        seq: 7,
        eventType: "assignee_changed",
        ...byAlice,
        payload: { assigneeId: null, assigneeType: null },
      },
    ]);

    const claimable = (await run(asAlice, { operation: "create", title: "Claim me" })).tasks[0]!;
    await run(asAgent, { operation: "claim", number: claimable.number });
    await run(asAgent, { operation: "unclaim", number: claimable.number });
    await run(asAlice, {
      operation: "assign",
      number: claimable.number,
      assignee: `@${agent.name}`,
    });
    const agentAssignee = { assigneeId: agent.id, assigneeType: "agent" as const };
    expect(await history(claimable.number)).toEqual([
      {
        seq: 1,
        eventType: "created",
        ...byAlice,
        payload: { taskNumber: claimable.number, status: "todo" },
      },
      {
        seq: 2,
        eventType: "assignee_changed",
        ...byAgent,
        payload: agentAssignee,
      },
      {
        seq: 3,
        eventType: "status_changed",
        ...byAgent,
        payload: { from: "todo", to: "in_progress" },
      },
      {
        seq: 4,
        eventType: "assignee_changed",
        ...byAgent,
        payload: { assigneeId: null, assigneeType: null },
      },
      {
        seq: 5,
        eventType: "assignee_changed",
        ...byAlice,
        payload: agentAssignee,
      },
    ]);

    const started = (
      await run(asAgent, {
        operation: "create",
        title: "Started by me",
        assignee: `@${agent.name}`,
      })
    ).tasks[0]!;
    expect(await history(started.number)).toEqual([
      {
        seq: 1,
        eventType: "created",
        ...byAgent,
        payload: { taskNumber: started.number, status: "in_progress" },
      },
      {
        seq: 2,
        eventType: "assignee_changed",
        ...byAgent,
        payload: agentAssignee,
      },
    ]);

    // Retries and no-op commands change nothing, so they record nothing.
    const retryKey = crypto.randomUUID();
    const batch = await run(asAlice, {
      operation: "create",
      titles: ["Batch one", "Batch two"],
      idempotencyKey: retryKey,
    });
    await run(asAlice, {
      operation: "create",
      titles: ["Batch one", "Batch two"],
      idempotencyKey: retryKey,
    });
    for (const created of batch.tasks)
      expect(await history(created.number)).toEqual([
        {
          seq: 1,
          eventType: "created",
          ...byAlice,
          payload: { taskNumber: created.number, status: "todo" },
        },
      ]);
    const assignKey = crypto.randomUUID();
    const reassign = {
      operation: "assign",
      number: claimable.number,
      assignee: `@${bob.username}`,
      idempotencyKey: assignKey,
    };
    await run(asAlice, reassign);
    const afterAssign = await history(claimable.number);
    await run(asAlice, reassign);
    await run(asAlice, { ...reassign, idempotencyKey: crypto.randomUUID() });
    expect(await history(claimable.number)).toEqual(afterAssign);
    await run(asAlice, { operation: "unassign", number: task.number });
    expect(await history(task.number)).toHaveLength(7);
    await run(asAgent, { operation: "claim", number: started.number });
    expect(await history(started.number)).toHaveLength(2);

    const message = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: channel.id,
        senderMemberId: channel.members.find((member) => member.userId === bob.id)!.id,
        sequence: 1_000,
        body: "Convert me",
      },
    });
    const converted = (await run(asBob, { operation: "convert", messageId: message.id })).tasks[0]!;
    expect(await history(converted.number)).toEqual([
      {
        seq: 1,
        eventType: "created",
        ...byBob,
        payload: { taskNumber: converted.number, status: "todo" },
      },
    ]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});
