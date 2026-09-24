import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { TaskBoard } from "#src/server/tasks/task-board.server";

test("TaskBoard overview returns every visible Workspace channel task and no direct-message task", async () => {
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
  // `include` returns agents in storage order; pick them by name.
  const aliceAgent = workspace.agents.find((agent) => agent.displayName === "Alice Agent");
  const bobAgent = workspace.agents.find((agent) => agent.displayName === "Bob Agent");
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
  // The joined channel belongs to a Project, so its tasks carry it (the Tasks page filters by it).
  const project = await db.project.create({
    data: { workspaceId: workspace.id, name: "Launch", slug: `launch-${short}` },
  });
  await db.conversation.update({ where: { id: joined.id }, data: { projectId: project.id } });
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
      { operation: "create", idempotencyKey: crypto.randomUUID(), conversationId, title },
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
    // Direct-message Tasks stay on their conversation's Tasks tab, even the viewer's own.
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.map(({ title }) => title).sort()).toEqual([
      "Joined public",
      "Unjoined public",
    ]);
    expect(result.tasks.find(({ title }) => title === "Joined public")).toEqual({
      ...joinedTask.tasks[0],
      currentMemberId: expect.any(String),
      source: { channelName: joined.channelName, agentId: null, label: `#${joined.channelName}` },
      project: { id: project.id, name: "Launch", slug: project.slug },
    });
    expect(result.tasks.find(({ title }) => title === "Unjoined public")).toEqual({
      ...unjoinedTask.tasks[0],
      currentMemberId: null,
      source: {
        channelName: unjoined.channelName,
        agentId: null,
        label: `#${unjoined.channelName}`,
      },
      project: null,
    });
    const joinedMember = await db.conversationMember.findFirst({
      where: { userId: alice!.id, conversationId: joined.id },
      select: { id: true },
    });
    expect(result.tasks.find(({ title }) => title === "Joined public")?.currentMemberId).toBe(
      joinedMember?.id,
    );
    expect(joinedTask.tasks[0]!.number).toBe(ownDmTask.tasks[0]!.number);

    await expect(board.overview(workspace.id, outsider!.id)).rejects.toThrow("ACCESS_DENIED");
  } finally {
    await db.workspace.deleteMany({ where: { id: { in: [workspace.id, otherWorkspace.id] } } });
    await db.user.deleteMany({ where: { id: { in: [alice!.id, bob!.id, outsider!.id] } } });
    await db.$disconnect();
  }
});

/**
 * A Workspace with one channel (in a Project), a joined channel outside any Project, the viewer's
 * direct conversation with an Agent, a channel the viewer has not joined, and a direct
 * conversation the viewer is not part of. Each Task
 * is created through the board, then its status and last update are set as the case needs.
 */
async function finishedWorkFixture() {
  const connectionString = Bun.env.TASK_TEST_DATABASE_URL ?? Bun.env.DATABASE_URL;
  if (!connectionString)
    throw new Error("TASK_TEST_DATABASE_URL or DATABASE_URL must point to local PostgreSQL");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const board = new TaskBoard(db);
  const short = crypto.randomUUID().slice(0, 8);
  const [viewer, peer] = await Promise.all(
    ["viewer", "peer"].map((name) =>
      db.user.create({ data: { username: `fin-${name}-${short}` } }),
    ),
  );
  const workspace = await db.workspace.create({
    data: {
      slug: `task-finished-${short}`,
      name: "Finished work",
      members: { create: [{ userId: viewer!.id }, { userId: peer!.id }] },
      agents: {
        create: [
          {
            name: `fin-agent-${short}`,
            displayName: "Viewer Agent",
            ownerId: viewer!.id,
            runtimeConfig: {},
          },
          {
            name: `fin-peer-agent-${short}`,
            displayName: "Peer Agent",
            ownerId: peer!.id,
            runtimeConfig: {},
          },
        ],
      },
    },
    include: { agents: true },
  });
  const viewerAgent = workspace.agents.find((agent) => agent.displayName === "Viewer Agent")!;
  const peerAgent = workspace.agents.find((agent) => agent.displayName === "Peer Agent")!;
  const project = await db.project.create({
    data: { workspaceId: workspace.id, name: "Launch", slug: `launch-${short}` },
  });
  const conversation = (data: {
    channelName?: string;
    userId: string;
    agentId?: string;
    projectId?: string;
  }) =>
    db.conversation.create({
      data: {
        workspaceId: workspace.id,
        channelName: data.channelName,
        projectId: data.projectId,
        directKey: data.agentId ? [data.userId, data.agentId].sort().join(":") : undefined,
        members: {
          create: [{ userId: data.userId }, ...(data.agentId ? [{ agentId: data.agentId }] : [])],
        },
      },
    });
  const channel = await conversation({
    channelName: `fin-${short}`,
    userId: viewer!.id,
    projectId: project.id,
  });
  // The peer joins the channel so a Task can be assigned to them.
  await db.conversationMember.create({
    data: { conversationId: channel.id, workspaceId: workspace.id, userId: peer!.id },
  });
  // A channel the viewer joined that belongs to no Project.
  const plain = await conversation({ channelName: `fin-plain-${short}`, userId: viewer!.id });
  const unjoined = await conversation({ channelName: `fin-unjoined-${short}`, userId: peer!.id });
  const ownDm = await conversation({ userId: viewer!.id, agentId: viewerAgent.id });
  const otherDm = await conversation({ userId: peer!.id, agentId: peerAgent.id });

  /** Creates a Task, then sets its status, owner and last update directly. */
  async function task(
    where: { id: string },
    creator: string,
    title: string,
    state: { status: string; daysAgo?: number; ownerUserId?: string },
  ) {
    const created = await board.execute(
      { workspaceId: workspace.id, userId: creator },
      { operation: "create", idempotencyKey: crypto.randomUUID(), conversationId: where.id, title },
    );
    const row = created.tasks[0]!;
    const owner = state.ownerUserId
      ? await db.conversationMember.findFirst({
          where: { conversationId: where.id, userId: state.ownerUserId },
          select: { id: true },
        })
      : null;
    const updatedAt = new Date(Date.now() - (state.daysAgo ?? 0) * 86_400_000);
    await db.$executeRaw`UPDATE tasks SET status = ${state.status}, "ownerMemberId" = ${owner?.id ?? null}::uuid, "updatedAt" = ${updatedAt} WHERE "messageId" = ${row.messageId}::uuid`;
    return row;
  }

  return {
    db,
    board,
    viewer: viewer!,
    peer: peer!,
    workspace,
    project,
    channel,
    plain,
    unjoined,
    ownDm,
    otherDm,
    task,
    async cleanup() {
      await db.workspace.deleteMany({ where: { id: workspace.id } });
      await db.user.deleteMany({ where: { id: { in: [viewer!.id, peer!.id] } } });
      await db.$disconnect();
    },
  };
}

test("TaskBoard overview leaves finished Tasks out", async () => {
  const f = await finishedWorkFixture();
  try {
    await f.task(f.channel, f.viewer.id, "Open work", { status: "todo" });
    await f.task(f.channel, f.viewer.id, "In review work", { status: "in_review" });
    await f.task(f.channel, f.viewer.id, "Finished work", { status: "done" });
    await f.task(f.channel, f.viewer.id, "Dropped work", { status: "closed" });

    const result = await f.board.overview(f.workspace.id, f.viewer.id);
    expect(result.tasks.map(({ title }) => title).sort()).toEqual(["In review work", "Open work"]);
  } finally {
    await f.cleanup();
  }
});

test("TaskBoard pages the viewer's finished Tasks newest first within the chosen window", async () => {
  const f = await finishedWorkFixture();
  try {
    await f.task(f.channel, f.viewer.id, "Done today", { status: "done" });
    await f.task(f.ownDm, f.viewer.id, "Done in own DM", { status: "done", daysAgo: 2 });
    await f.task(f.unjoined, f.peer.id, "Done in unjoined channel", { status: "done", daysAgo: 3 });
    await f.task(f.channel, f.viewer.id, "Done ten days ago", { status: "done", daysAgo: 10 });
    await f.task(f.channel, f.viewer.id, "Done two months ago", { status: "done", daysAgo: 60 });
    await f.task(f.channel, f.viewer.id, "Closed today", { status: "closed" });
    await f.task(f.channel, f.viewer.id, "Still open", { status: "todo" });
    await f.task(f.otherDm, f.peer.id, "Done in someone else's DM", { status: "done" });

    const page = (window: "week" | "month" | "all", cursor?: string | null, limit?: number) =>
      f.board.finishedPage(
        { workspaceId: f.workspace.id, userId: f.viewer.id },
        { status: "done", window, cursor, limit },
      );
    const titles = (result: { tasks: { title: string }[] }) =>
      result.tasks.map(({ title }) => title);

    // Direct-message Tasks, the viewer's own included, are not the Tasks page's.
    expect(titles(await page("week"))).toEqual(["Done today", "Done in unjoined channel"]);
    expect(titles(await page("month"))).toEqual([
      "Done today",
      "Done in unjoined channel",
      "Done ten days ago",
    ]);

    const first = await page("all", null, 2);
    expect(titles(first)).toEqual(["Done today", "Done in unjoined channel"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const last = await page("all", first.nextCursor, 2);
    expect(titles(last)).toEqual(["Done ten days ago", "Done two months ago"]);
    expect(last.nextCursor).toBeNull();

    // A page row reads like an overview row, so the board renders both the same way.
    expect(first.tasks[0]).toMatchObject({
      status: "done",
      source: { channelName: f.channel.channelName, label: `#${f.channel.channelName}` },
      project: { id: f.project.id, name: "Launch" },
      currentMemberId: expect.any(String),
    });
  } finally {
    await f.cleanup();
  }
});

test("TaskBoard filters a finished page by owner and Project like the Tasks page filters", async () => {
  const f = await finishedWorkFixture();
  try {
    await f.task(f.channel, f.viewer.id, "Viewer's in Launch", {
      status: "done",
      ownerUserId: f.viewer.id,
    });
    await f.task(f.channel, f.viewer.id, "Peer's in Launch", {
      status: "done",
      ownerUserId: f.peer.id,
    });
    await f.task(f.channel, f.viewer.id, "Nobody's in Launch", { status: "done", daysAgo: 1 });
    await f.task(f.plain, f.viewer.id, "Viewer's without Project", {
      status: "done",
      ownerUserId: f.viewer.id,
      daysAgo: 2,
    });
    await f.task(f.ownDm, f.viewer.id, "Viewer's in own DM", {
      status: "done",
      ownerUserId: f.viewer.id,
      daysAgo: 2,
    });

    const titles = async (filter: { owners?: string[]; projects?: string[] }) =>
      (
        await f.board.finishedPage(
          { workspaceId: f.workspace.id, userId: f.viewer.id },
          { status: "done", window: "week", ...filter },
        )
      ).tasks
        .map(({ title }) => title)
        .sort();

    expect(await titles({ owners: [f.viewer.id] })).toEqual([
      "Viewer's in Launch",
      "Viewer's without Project",
    ]);
    expect(await titles({ owners: [f.peer.id, "none"] })).toEqual([
      "Nobody's in Launch",
      "Peer's in Launch",
    ]);
    expect(await titles({ projects: ["none"] })).toEqual(["Viewer's without Project"]);
    expect(await titles({ owners: [f.viewer.id], projects: [f.project.id] })).toEqual([
      "Viewer's in Launch",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("TaskBoard summarizes the viewer's finished Tasks in the window by status, owner and Project", async () => {
  const f = await finishedWorkFixture();
  try {
    await f.task(f.channel, f.viewer.id, "A", { status: "done", ownerUserId: f.viewer.id });
    await f.task(f.channel, f.viewer.id, "B", {
      status: "done",
      ownerUserId: f.viewer.id,
      daysAgo: 1,
    });
    await f.task(f.channel, f.viewer.id, "C", { status: "done", ownerUserId: f.peer.id });
    await f.task(f.plain, f.viewer.id, "D", { status: "closed", daysAgo: 3 });
    await f.task(f.ownDm, f.viewer.id, "In own DM", { status: "done", ownerUserId: f.viewer.id });
    await f.task(f.channel, f.viewer.id, "Too old", { status: "done", daysAgo: 20 });
    await f.task(f.channel, f.viewer.id, "Open", { status: "todo" });
    await f.task(f.otherDm, f.peer.id, "Hidden", { status: "done" });

    const summary = await f.board.finishedSummary(
      { workspaceId: f.workspace.id, userId: f.viewer.id },
      { window: "week" },
    );
    const groups = summary.groups
      .map((group) => ({
        status: group.status,
        owner: group.owner?.id ?? null,
        viewerOwns: group.owner !== null && group.owner.memberId === group.currentMemberId,
        project: group.project?.id ?? null,
        count: group.count,
      }))
      .sort((left, right) =>
        `${left.status}${left.owner}`.localeCompare(`${right.status}${right.owner}`),
      );
    const expected: typeof groups = [
      { status: "closed", owner: null, viewerOwns: false, project: null, count: 1 },
      { status: "done", owner: f.peer.id, viewerOwns: false, project: f.project.id, count: 1 },
      { status: "done", owner: f.viewer.id, viewerOwns: true, project: f.project.id, count: 2 },
    ];
    expect(groups).toEqual(
      expected.sort((left, right) =>
        `${left.status}${left.owner}`.localeCompare(`${right.status}${right.owner}`),
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("TaskBoard pages and summarizes one conversation's finished Tasks for the conversation Tasks tab", async () => {
  const f = await finishedWorkFixture();
  try {
    await f.task(f.channel, f.viewer.id, "Channel done", { status: "done" });
    await f.task(f.ownDm, f.viewer.id, "DM done", { status: "done" });
    await f.task(f.unjoined, f.peer.id, "Unjoined done", { status: "done", daysAgo: 1 });
    await f.task(f.otherDm, f.peer.id, "Other DM done", { status: "done" });

    const scope = (conversationId: string) => ({
      workspaceId: f.workspace.id,
      userId: f.viewer.id,
      conversationId,
    });
    const titles = async (conversationId: string) =>
      (
        await f.board.finishedPage(scope(conversationId), { status: "done", window: "week" })
      ).tasks.map(({ title }) => title);

    expect(await titles(f.channel.id)).toEqual(["Channel done"]);
    // A direct message keeps its own Tasks tab, though the Tasks page leaves it out.
    expect(await titles(f.ownDm.id)).toEqual(["DM done"]);
    // A public channel reads to every Workspace member, joined or not, as its Task list does.
    expect(await titles(f.unjoined.id)).toEqual(["Unjoined done"]);
    const summary = await f.board.finishedSummary(scope(f.channel.id), { window: "week" });
    expect(summary.groups.map(({ status, count }) => ({ status, count }))).toEqual([
      { status: "done", count: 1 },
    ]);

    await expect(titles(f.otherDm.id)).rejects.toThrow("ACCESS_DENIED");
    await expect(f.board.finishedSummary(scope(f.otherDm.id), { window: "week" })).rejects.toThrow(
      "ACCESS_DENIED",
    );
  } finally {
    await f.cleanup();
  }
});

test("TaskBoard reads one Task as an overview row, finished or not, only in a channel the viewer sees", async () => {
  const f = await finishedWorkFixture();
  try {
    const done = await f.task(f.channel, f.viewer.id, "Done long ago", {
      status: "done",
      daysAgo: 90,
    });
    const hidden = await f.task(f.otherDm, f.peer.id, "Someone else's", { status: "todo" });
    const own = await f.task(f.ownDm, f.viewer.id, "In own DM", { status: "todo" });
    const scope = { workspaceId: f.workspace.id, userId: f.viewer.id };

    expect(
      await f.board.overviewTask(scope, { conversationId: f.channel.id, number: done.number }),
    ).toMatchObject({
      title: "Done long ago",
      status: "done",
      source: { label: `#${f.channel.channelName}` },
      project: { id: f.project.id },
    });
    expect(
      await f.board.overviewTask(scope, { conversationId: f.otherDm.id, number: hidden.number }),
    ).toBeNull();
    expect(
      await f.board.overviewTask(scope, { conversationId: f.ownDm.id, number: own.number }),
    ).toBeNull();
    expect(
      await f.board.overviewTask(scope, { conversationId: f.channel.id, number: 999 }),
    ).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test("TaskBoard pages Tasks updated at the same instant across a page boundary once each", async () => {
  const f = await finishedWorkFixture();
  try {
    const rows = [];
    for (const title of ["A", "B", "C", "D", "E"])
      rows.push(await f.task(f.channel, f.viewer.id, title, { status: "done", daysAgo: 1 }));
    const instant = new Date(Date.now() - 86_400_000);
    await f.db.task.updateMany({
      where: { messageId: { in: rows.map(({ messageId }) => messageId) } },
      data: { updatedAt: instant },
    });
    const read = (cursor?: string | null) =>
      f.board.finishedPage(
        { workspaceId: f.workspace.id, userId: f.viewer.id },
        { status: "done", window: "week", cursor, limit: 2 },
      );
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await read(cursor);
      seen.push(...page.tasks.map(({ messageId }) => messageId));
      cursor = page.nextCursor;
    } while (cursor);
    // Same update time: the message id breaks the tie, highest first.
    expect(seen).toEqual(
      rows
        .map(({ messageId }) => messageId)
        .sort()
        .reverse(),
    );
  } finally {
    await f.cleanup();
  }
});

test("TaskBoard leaves a channel hidden from the Workspace out of every finished read", async () => {
  const f = await finishedWorkFixture();
  try {
    const hidden = await f.task(f.channel, f.viewer.id, "Hidden done", { status: "done" });
    await f.db.conversation.update({
      where: { id: f.channel.id },
      data: { hiddenFromWorkspaceAt: new Date() },
    });
    const scope = { workspaceId: f.workspace.id, userId: f.viewer.id };
    const page = await f.board.finishedPage(scope, { status: "done", window: "all" });
    expect(page.tasks).toEqual([]);
    const summary = await f.board.finishedSummary(scope, { window: "all" });
    expect(summary.groups).toEqual([]);
    expect(
      await f.board.overviewTask(scope, { conversationId: f.channel.id, number: hidden.number }),
    ).toBeNull();
  } finally {
    await f.cleanup();
  }
});
