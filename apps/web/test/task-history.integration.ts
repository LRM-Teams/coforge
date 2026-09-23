import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import type { TaskHistoryEvent } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "../generated/client";
import { TaskBoard } from "../src/server/tasks/task-board.server";

const eventShape = ({ eventType, actorType, actorName, payload }: TaskHistoryEvent) => ({
  eventType,
  actorType,
  actorName,
  payload,
});

test("every Task change records one history event with its before and after state", async () => {
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
  const memberOf = (id: string) =>
    channel.members.find((member) => member.userId === id || member.agentId === id)!.id;
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
        eventType: "created",
        actorType: "user",
        actorName: alice.username,
        payload: { taskNumber: task.number, status: "todo" },
      },
      {
        eventType: "assignee_changed",
        actorType: "user",
        actorName: alice.username,
        payload: { assigneeId: bob.id, assigneeType: "user" },
      },
      {
        eventType: "status_changed",
        actorType: "user",
        actorName: bob.username,
        payload: { from: "todo", to: "in_progress" },
      },
      {
        eventType: "status_changed",
        actorType: "user",
        actorName: bob.username,
        payload: { from: "in_progress", to: "in_review" },
      },
      {
        eventType: "amended",
        actorType: "user",
        actorName: alice.username,
        payload: {
          changes: { title: { from: "Ship history", to: "Ship task history" } },
          revision: 4,
        },
      },
      {
        eventType: "status_changed",
        actorType: "user",
        actorName: alice.username,
        payload: { from: "in_review", to: "done" },
      },
      {
        eventType: "assignee_changed",
        actorType: "user",
        actorName: alice.username,
        payload: { assigneeId: null, assigneeType: null },
      },
    ]);
    const events = (await run(asAlice, { operation: "history", number: task.number })).history!;
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);

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
        eventType: "created",
        actorType: "user",
        actorName: alice.username,
        payload: { taskNumber: claimable.number, status: "todo" },
      },
      {
        eventType: "assignee_changed",
        actorType: "agent",
        actorName: agent.name,
        payload: agentAssignee,
      },
      {
        eventType: "status_changed",
        actorType: "agent",
        actorName: agent.name,
        payload: { from: "todo", to: "in_progress" },
      },
      {
        eventType: "assignee_changed",
        actorType: "agent",
        actorName: agent.name,
        payload: { assigneeId: null, assigneeType: null },
      },
      {
        eventType: "assignee_changed",
        actorType: "user",
        actorName: alice.username,
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
        eventType: "created",
        actorType: "agent",
        actorName: agent.name,
        payload: { taskNumber: started.number, status: "in_progress" },
      },
      {
        eventType: "assignee_changed",
        actorType: "agent",
        actorName: agent.name,
        payload: agentAssignee,
      },
    ]);

    const message = await db.message.create({
      data: {
        workspaceId: workspace.id,
        conversationId: channel.id,
        senderMemberId: memberOf(bob.id),
        sequence: 1_000,
        body: "Convert me",
      },
    });
    const converted = (await run(asBob, { operation: "convert", messageId: message.id })).tasks[0]!;
    expect(await history(converted.number)).toEqual([
      {
        eventType: "created",
        actorType: "user",
        actorName: bob.username,
        payload: { taskNumber: converted.number, status: "todo" },
      },
    ]);
  } finally {
    await db.workspace.delete({ where: { id: workspace.id } });
    await db.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  }
});
