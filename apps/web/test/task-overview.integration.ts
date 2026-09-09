import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { TaskBoard } from "../src/server/tasks/task-board.server";

test("TaskBoard overview returns every visible Workspace task without leaking private conversations", async () => {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const board = new TaskBoard(db);
  const suffix = crypto.randomUUID();
  const short = suffix.slice(0, 8);
  const [alice, bob, outsider] = await Promise.all(
    ["alice", "bob", "outsider"].map((name) =>
      db.user.create({ data: { username: `overview-${name}-${short}` } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `task-overview-${suffix}`,
      name: "Task overview",
      members: { create: [{ userId: alice!.id }, { userId: bob!.id }] },
      agents: {
        create: [
          {
            name: `overview-agent-${short}`,
            displayName: "Alice Agent",
            ownerId: alice!.id,
            runtimeConfig: {},
          },
          {
            name: `overview-peer-${short}`,
            displayName: "Bob Agent",
            ownerId: bob!.id,
            runtimeConfig: {},
          },
        ],
      },
    },
    include: { agents: true },
  });
  const [aliceAgent, bobAgent] = workspace.agents;
  const otherWorkspace = await db.workspace.create({
    data: {
      slug: `task-overview-other-${suffix}`,
      name: "Other task overview",
      members: { create: { userId: alice!.id } },
    },
  });

  const makeConversation = (data: {
    workspaceId?: string;
    channelName?: string;
    userId: string;
    agentId?: string;
  }) =>
    db.conversation.create({
      data: {
        workspaceId: data.workspaceId ?? workspace.id,
        channelName: data.channelName,
        directKey: data.agentId ? [data.userId, data.agentId].sort().join(":") : undefined,
        members: {
          create: [{ userId: data.userId }, ...(data.agentId ? [{ agentId: data.agentId }] : [])],
        },
      },
    });

  const joined = await makeConversation({ channelName: `joined-${short}`, userId: alice!.id });
  const unjoined = await makeConversation({ channelName: `unjoined-${short}`, userId: bob!.id });
  const ownDm = await makeConversation({ userId: alice!.id, agentId: aliceAgent!.id });
  const otherDm = await makeConversation({ userId: bob!.id, agentId: bobAgent!.id });
  const foreign = await makeConversation({
    workspaceId: otherWorkspace.id,
    channelName: `foreign-${short}`,
    userId: alice!.id,
  });

  const createTask = (userId: string, workspaceId: string, conversationId: string, title: string) =>
    board.execute(
      { workspaceId, userId },
      { operation: "create", requestId: crypto.randomUUID(), conversationId, title },
    );

  try {
    const [joinedTask, unjoinedTask, ownDmTask] = await Promise.all([
      createTask(alice!.id, workspace.id, joined.id, "Joined public"),
      createTask(bob!.id, workspace.id, unjoined.id, "Unjoined public"),
      createTask(alice!.id, workspace.id, ownDm.id, "Own direct"),
      createTask(bob!.id, workspace.id, otherDm.id, "Other direct"),
      createTask(alice!.id, otherWorkspace.id, foreign.id, "Other workspace"),
    ]);

    const result = await board.overview(workspace.id, alice!.id);
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks.map(({ title }) => title).sort()).toEqual([
      "Joined public",
      "Own direct",
      "Unjoined public",
    ]);
    expect(result.tasks.find(({ title }) => title === "Joined public")).toEqual({
      ...joinedTask.tasks[0],
      currentMemberId: expect.any(String),
      source: { channelName: joined.channelName, agentId: null, label: `#${joined.channelName}` },
    });
    expect(result.tasks.find(({ title }) => title === "Unjoined public")).toEqual({
      ...unjoinedTask.tasks[0],
      currentMemberId: null,
      source: {
        channelName: unjoined.channelName,
        agentId: null,
        label: `#${unjoined.channelName}`,
      },
    });
    expect(result.tasks.find(({ title }) => title === "Own direct")).toEqual({
      ...ownDmTask.tasks[0],
      currentMemberId: expect.any(String),
      source: { channelName: null, agentId: aliceAgent!.id, label: "Alice Agent" },
    });
    const memberIds = await db.conversationMember.findMany({
      where: { userId: alice!.id, conversationId: { in: [joined.id, ownDm.id] } },
      select: { id: true, conversationId: true },
    });
    expect(result.tasks.find(({ title }) => title === "Joined public")?.currentMemberId).toBe(
      memberIds.find(({ conversationId }) => conversationId === joined.id)?.id,
    );
    expect(result.tasks.find(({ title }) => title === "Own direct")?.currentMemberId).toBe(
      memberIds.find(({ conversationId }) => conversationId === ownDm.id)?.id,
    );
    expect(joinedTask.tasks[0]!.number).toBe(ownDmTask.tasks[0]!.number);

    await expect(board.overview(workspace.id, outsider!.id)).rejects.toThrow("ACCESS_DENIED");
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [workspace.id, otherWorkspace.id] } } });
    await db.user.deleteMany({ where: { id: { in: [alice!.id, bob!.id, outsider!.id] } } });
    await db.$disconnect();
  }
});
