import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client";
import { isAppError } from "../src/lib/app-error";
import {
  collectEpisodeBody,
  ingestCompletedTask,
  ingestQuietWindow,
  listIngestableCompletedTasks,
  listQuietChannelCandidates,
  MemoryIngestionSweep,
  RedisMemoryIngestionSweepLock,
} from "../src/server/group-memory/memory-ingestion.server";
import { extractInteractionLinks } from "../src/server/group-memory/memory-interactions.server";

/**
 * Stand-in for the Memory Agent enablement lifecycle (ADR 0052-H, slice 4):
 * insert the designation row directly — "enabled" means exactly that row.
 */
async function enableGroupMemory(
  db: PrismaClient,
  input: { workspaceId: string; ownerId: string },
): Promise<void> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const agent = await db.agent.create({
    data: {
      workspaceId: input.workspaceId,
      name: `memory-${suffix}`,
      displayName: `Memory ${suffix}`,
      ownerId: input.ownerId,
      runtimeConfig: {},
    },
  });
  await db.memoryAgentDesignation.create({
    data: { workspaceId: input.workspaceId, agentId: agent.id },
  });
}

/**
 * Group Memory ingestion value semantics against local PostgreSQL (ADR 0053,
 * slice 2): completion-state Task admission with window locking, quiet-window
 * lifecycle anchored to the newest message, the DirectConversation privacy
 * boundary enforced at both the scan layer and the entry points, and the
 * sweep's lock/idempotency contract.
 *
 * Runs via `mise run test:memory` with MEMORY_TEST_DATABASE_URL pointing at
 * a scratch database.
 */

let client: PrismaClient | undefined;

function getDb(): PrismaClient {
  if (client) return client;
  const connectionString = Bun.env.MEMORY_TEST_DATABASE_URL;
  if (!connectionString) throw new Error("MEMORY_TEST_DATABASE_URL must point at local PostgreSQL");
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}

const QUIET_MS = 30 * 60_000;

type Setup = {
  db: PrismaClient;
  workspaceId: string;
  conversationId: string;
  memberId: string;
  userId: string;
  addMessage: (
    body: string,
    options?: {
      createdAt?: Date;
      sender?: boolean;
      senderMemberId?: string;
      threadRootId?: string;
    },
  ) => Promise<string>;
  addTask: (options?: {
    status?: string;
    rootSequence?: number;
    conversationId?: string;
  }) => Promise<string>;
};

async function setup(): Promise<Setup> {
  const db = getDb();
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({ data: { username: `ing-owner-${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `ing-${suffix}`,
      name: "Ingestion Test",
      members: { create: [{ userId: user.id, role: "owner" }] },
    },
  });
  // Sweeps run only where Group Memory is enabled (ADR 0054-H).
  await enableGroupMemory(db, { workspaceId: workspace.id, ownerId: user.id });
  const conversation = await db.conversation.create({
    data: { workspaceId: workspace.id, channelName: `ingest-${suffix}` },
  });
  const member = await db.conversationMember.create({
    data: { conversationId: conversation.id, workspaceId: workspace.id, userId: user.id },
  });
  let sequence = 0;
  const addMessage: Setup["addMessage"] = async (body, options = {}) => {
    sequence += 1;
    const messageId = crypto.randomUUID();
    await db.message.create({
      data: {
        id: messageId,
        conversationId: conversation.id,
        workspaceId: workspace.id,
        senderMemberId: options.sender === false ? null : (options.senderMemberId ?? member.id),
        body,
        sequence,
        ...(options.threadRootId ? { threadRootId: options.threadRootId } : {}),
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      },
    });
    return messageId;
  };
  const addTask: Setup["addTask"] = async (options = {}) => {
    const taskConversationId = options.conversationId ?? conversation.id;
    const taskMessageId = crypto.randomUUID();
    let rootSequence = options.rootSequence;
    if (rootSequence === undefined) {
      sequence += 1;
      rootSequence = sequence;
    } else {
      sequence = Math.max(sequence, rootSequence);
    }
    await db.message.create({
      data: {
        id: taskMessageId,
        conversationId: taskConversationId,
        workspaceId: workspace.id,
        senderMemberId: member.id,
        body: "task root message",
        sequence: rootSequence,
      },
    });
    const taskRow = await db.task.findFirst({
      where: { conversationId: taskConversationId },
      select: { number: true },
      orderBy: { number: "desc" },
    });
    await db.task.create({
      data: {
        messageId: taskMessageId,
        conversationId: taskConversationId,
        workspaceId: workspace.id,
        number: (taskRow?.number ?? 0) + 1,
        title: "Sample task",
        status: options.status ?? "done",
        creatorMemberId: member.id,
      },
    });
    return taskMessageId;
  };
  return {
    db,
    workspaceId: workspace.id,
    conversationId: conversation.id,
    memberId: member.id,
    userId: user.id,
    addMessage,
    addTask,
  };
}

test("completed Task admits its window once, then locks the boundary against later messages", async () => {
  const s = await setup();
  await s.addMessage("alice: opening note");
  const taskMessageId = await s.addTask({ rootSequence: 2 });
  await s.addMessage("bob: working on the task");
  await s.addMessage("bob: done with the task");

  const first = await ingestCompletedTask(s.db, { taskMessageId });
  expect(first.skipped).toBe(false);
  const episode = await s.db.memoryEpisode.findUnique({
    where: { id: (first as { episodeId: string }).episodeId },
  });
  expect(episode?.kind).toBe("task");
  expect(episode?.taskMessageId).toBe(taskMessageId);
  expect(episode?.startSequence).toBe(2);
  expect(episode?.endSequence).toBe(4);
  expect(episode?.title).toBe("Sample task");
  expect(episode?.body).not.toContain("opening note");
  expect(episode?.body).toContain("bob: working on the task");
  expect(episode?.body).toContain("bob: done with the task");

  await s.addMessage("alice: after completion chatter");
  const second = await ingestCompletedTask(s.db, { taskMessageId });
  expect(second.skipped).toBe("already_ingested");
  expect(await s.db.memoryEpisode.count({ where: { workspaceId: s.workspaceId } })).toBe(1);
  const body = await collectEpisodeBody(s.db, {
    conversationId: s.conversationId,
    startSequence: 2,
    endSequence: 4,
  });
  expect(body.split("\n")).toHaveLength(3);
});

test("a Task that is not completed never admits an episode", async () => {
  const s = await setup();
  await s.addMessage("alice: planning");
  const taskMessageId = await s.addTask({ status: "in_progress", rootSequence: 2 });
  const outcome = await ingestCompletedTask(s.db, { taskMessageId });
  expect(outcome.skipped).toBe("not_completed");
  expect(await s.db.memoryEpisode.count({ where: { workspaceId: s.workspaceId } })).toBe(0);
});

test("DirectConversations cannot reach memory at any layer", async () => {
  const s = await setup();
  await s.addMessage("alice: private window");
  const dm = await s.db.conversation.create({
    data: { workspaceId: s.workspaceId, directKey: `dm-${crypto.randomUUID().slice(0, 8)}` },
  });
  const dmMember = await s.db.conversationMember.create({
    data: { conversationId: dm.id, workspaceId: s.workspaceId, userId: s.userId },
  });
  const dmFirstMessageId = crypto.randomUUID();
  await s.db.message.create({
    data: {
      id: dmFirstMessageId,
      conversationId: dm.id,
      workspaceId: s.workspaceId,
      senderMemberId: null,
      body: "secret direct message",
      sequence: 1,
    },
  });
  const dmTaskMessageId = crypto.randomUUID();
  await s.db.message.create({
    data: {
      id: dmTaskMessageId,
      conversationId: dm.id,
      workspaceId: s.workspaceId,
      body: "private task root",
      sequence: 2,
      senderMemberId: null,
    },
  });
  await s.db.task.create({
    data: {
      messageId: dmTaskMessageId,
      conversationId: dm.id,
      workspaceId: s.workspaceId,
      number: 1,
      title: "Private task",
      status: "done",
      creatorMemberId: dmMember.id,
    },
  });

  const tasks = await listIngestableCompletedTasks(s.db);
  expect(tasks.map((candidate) => candidate.taskMessageId)).not.toContain(dmTaskMessageId);
  for (const candidate of tasks) {
    const candidateTask = await s.db.task.findUnique({
      where: { messageId: candidate.taskMessageId },
      select: { workspaceId: true },
    });
    expect(candidateTask?.workspaceId).not.toBe(s.workspaceId);
  }

  const quiet = await listQuietChannelCandidates(s.db, { now: Date.now() + QUIET_MS });
  expect(quiet.map((candidate) => candidate.conversationId)).not.toContain(dm.id);

  const dmTask = await s.db.task.findFirstOrThrow({
    where: { conversationId: dm.id },
    select: { messageId: true },
  });
  try {
    await ingestCompletedTask(s.db, { taskMessageId: dmTask.messageId });
    throw new Error("expected ACCESS_DENIED");
  } catch (error) {
    expect(isAppError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("ACCESS_DENIED");
    expect((error as { errorId?: string }).errorId).toBe("gm-ingest-direct-conversation");
  }
  try {
    await ingestQuietWindow(s.db, { conversationId: dm.id, now: Date.now() + QUIET_MS });
    throw new Error("expected ACCESS_DENIED");
  } catch (error) {
    expect(isAppError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("ACCESS_DENIED");
  }
  expect(await s.db.memoryEpisode.count({ where: { workspaceId: s.workspaceId } })).toBe(0);
});

test("quiet window admits only after silence, then resumes after the next burst", async () => {
  const s = await setup();
  const t0 = Date.parse("2026-09-20T10:00:00Z");
  await s.addMessage("alice: morning update", { createdAt: new Date(t0) });
  await s.addMessage("bob: acknowledged", { createdAt: new Date(t0 + 60_000) });
  await s.addMessage("alice: heading out", { createdAt: new Date(t0 + 120_000) });

  const tooEarly = await ingestQuietWindow(s.db, {
    conversationId: s.conversationId,
    now: t0 + 10 * 60_000,
  });
  expect(tooEarly.skipped).toBe("quiet_window_not_reached");

  const admitted = await ingestQuietWindow(s.db, {
    conversationId: s.conversationId,
    now: t0 + 45 * 60_000,
  });
  expect(admitted.skipped).toBe(false);
  const episode = await s.db.memoryEpisode.findUnique({
    where: { id: (admitted as { episodeId: string }).episodeId },
  });
  expect(episode?.kind).toBe("quiet_window");
  expect(episode?.startSequence).toBe(1);
  expect(episode?.endSequence).toBe(3);

  const replay = await ingestQuietWindow(s.db, {
    conversationId: s.conversationId,
    now: t0 + 50 * 60_000,
  });
  expect(replay.skipped).toBe("window_empty");

  const nextBurstAt = t0 + 2 * 60 * 60_000;
  await s.addMessage("bob: new topic tomorrow", { createdAt: new Date(nextBurstAt) });
  const burstNotQuiet = await ingestQuietWindow(s.db, {
    conversationId: s.conversationId,
    now: nextBurstAt + 5 * 60_000,
  });
  expect(burstNotQuiet.skipped).toBe("quiet_window_not_reached");
  const burstAdmitted = await ingestQuietWindow(s.db, {
    conversationId: s.conversationId,
    now: nextBurstAt + 45 * 60_000,
  });
  expect(burstAdmitted.skipped).toBe(false);
  const nextEpisode = await s.db.memoryEpisode.findUnique({
    where: { id: (burstAdmitted as { episodeId: string }).episodeId },
  });
  expect(nextEpisode?.startSequence).toBe(4);
  expect(nextEpisode?.endSequence).toBe(4);
});

test("sweep tick ingests both trigger kinds once and respects the distributed lock", async () => {
  const s = await setup();
  const t0 = Date.parse("2026-09-20T12:00:00Z");
  await s.addMessage("alice: quiet opener", { createdAt: new Date(t0) });
  const taskMessageId = await s.addTask({ rootSequence: 2, status: "done" });

  const alwaysLocked: { acquire: (id: string) => Promise<boolean> } = {
    acquire: async () => false,
  };
  const idle = new MemoryIngestionSweep(s.db, alwaysLocked, () => t0 + 45 * 60_000);
  await idle.tick();
  expect(await s.db.memoryEpisode.count({ where: { workspaceId: s.workspaceId } })).toBe(0);

  const alwaysFree: { acquire: (id: string) => Promise<boolean> } = {
    acquire: async () => true,
  };
  const sweep = new MemoryIngestionSweep(s.db, alwaysFree, () => t0 + 45 * 60_000);
  await sweep.tick();
  const episodes = await s.db.memoryEpisode.findMany({
    where: { workspaceId: s.workspaceId },
    orderBy: { kind: "asc" },
  });
  expect(episodes.map((episode) => episode.kind).sort()).toEqual(["quiet_window", "task"]);
  const quietEpisode = episodes.find((episode) => episode.kind === "quiet_window");
  expect(quietEpisode?.startSequence).toBe(1);
  expect(quietEpisode?.endSequence).toBe(2);
  const taskEpisode = episodes.find((episode) => episode.kind === "task");
  expect(taskEpisode?.startSequence).toBe(2);
  expect(taskEpisode?.endSequence).toBe(2);

  await sweep.tick();
  expect(await s.db.memoryEpisode.count({ where: { workspaceId: s.workspaceId } })).toBe(2);

  const candidates = await listIngestableCompletedTasks(s.db);
  expect(candidates.map((candidate) => candidate.taskMessageId)).not.toContain(taskMessageId);
});

test("Redis lock acquires on NX and reports a held lock as false", async () => {
  const calls: Array<{ key: string; value: string; options: unknown[] }> = [];
  const port = {
    set: async (key: string, value: string, ...options: Array<string | number>) => {
      calls.push({ key, value, options });
      return "OK";
    },
  };
  const lock = new RedisMemoryIngestionSweepLock(port);
  expect(await lock.acquire("instance-a")).toBe(true);
  expect(calls[0]).toMatchObject({ key: "coforge:group-memory:ingestion-sweep:lock" });

  const heldPort = {
    set: async () => null,
  };
  const heldLock = new RedisMemoryIngestionSweepLock(heldPort);
  expect(await heldLock.acquire("instance-b")).toBe(false);
});

test("ingestion snapshots participants and extracts the three link kinds losslessly", async () => {
  const s = await setup();
  const suffix = crypto.randomUUID().slice(0, 8);
  const alice = await s.db.user.findUniqueOrThrow({ where: { id: s.userId } });
  const agent = await s.db.agent.create({
    data: {
      workspaceId: s.workspaceId,
      name: `scout-${suffix}`,
      displayName: "Scout",
      ownerId: s.userId,
      runtimeConfig: {},
    },
  });
  const agentMember = await s.db.conversationMember.create({
    data: { conversationId: s.conversationId, workspaceId: s.workspaceId, agentId: agent.id },
  });
  const t0 = Date.parse("2026-09-20T14:00:00Z");
  const opening = await s.addMessage("alice: opening the deploy discussion", {
    createdAt: new Date(t0),
  });
  await s.addMessage("let me check the pipeline", {
    createdAt: new Date(t0 + 60_000),
    senderMemberId: agentMember.id,
  });
  const mentionLine = await s.addMessage("scout: reporting back", {
    createdAt: new Date(t0 + 120_000),
    senderMemberId: agentMember.id,
  });
  await s.db.messageMention.create({
    data: {
      messageId: mentionLine,
      memberId: s.memberId,
      conversationId: s.conversationId,
      workspaceId: s.workspaceId,
      kind: "user",
      actorId: s.userId,
      handle: alice.username,
    },
  });

  const first = await ingestQuietWindow(s.db, {
    conversationId: s.conversationId,
    now: t0 + 45 * 60_000,
  });
  expect(first.skipped).toBe(false);
  const firstEpisode = await s.db.memoryEpisode.findUniqueOrThrow({
    where: { id: (first as { episodeId: string }).episodeId },
  });
  expect(firstEpisode.participants).toEqual([
    { kind: "agent", id: agent.id, handle: `scout-${suffix}` },
    { kind: "human", id: s.userId, handle: alice.username },
  ]);
  const mentionEdges = await s.db.memoryInteractionLink.findMany({
    where: { conversationId: s.conversationId, kind: "mentions" },
  });
  expect(mentionEdges).toHaveLength(1);
  expect(mentionEdges[0].fromMessageId).toBe(mentionLine);
  expect(mentionEdges[0].toMemberId).toBe(s.memberId);

  const taskRoot = await s.addMessage("alice: task for scout", {
    createdAt: new Date(t0 + 2 * 60 * 60_000),
  });
  await s.db.task.create({
    data: {
      messageId: taskRoot,
      conversationId: s.conversationId,
      workspaceId: s.workspaceId,
      number: 1,
      title: "Delegated work",
      status: "done",
      creatorMemberId: s.memberId,
      ownerMemberId: agentMember.id,
    },
  });
  const reply = await s.addMessage("scout: replying to the opening", {
    createdAt: new Date(t0 + 2 * 60 * 60_000 + 60_000),
    senderMemberId: agentMember.id,
    threadRootId: opening,
  });
  const selfTaskRoot = await s.addMessage("self-assigned task root", {
    createdAt: new Date(t0 + 2 * 60 * 60_000 + 120_000),
  });
  await s.db.task.create({
    data: {
      messageId: selfTaskRoot,
      conversationId: s.conversationId,
      workspaceId: s.workspaceId,
      number: 2,
      title: "Self work",
      status: "done",
      creatorMemberId: s.memberId,
      ownerMemberId: s.memberId,
    },
  });

  const second = await ingestQuietWindow(s.db, {
    conversationId: s.conversationId,
    now: t0 + 3 * 60 * 60_000,
  });
  expect(second.skipped).toBe(false);
  const links = await s.db.memoryInteractionLink.findMany({
    where: { conversationId: s.conversationId },
  });
  const respondsTo = links.find((link) => link.kind === "responds_to");
  expect(respondsTo?.fromMessageId).toBe(reply);
  expect(respondsTo?.toMessageId).toBe(opening);
  const delegates = links.find((link) => link.kind === "delegates_to");
  expect(delegates?.fromMessageId).toBe(taskRoot);
  expect(delegates?.toMemberId).toBe(agentMember.id);
  expect(links.filter((link) => link.kind === "delegates_to")).toHaveLength(1);

  const before = await s.db.memoryInteractionLink.count({
    where: { conversationId: s.conversationId },
  });
  const replay = await extractInteractionLinks(s.db, {
    workspaceId: s.workspaceId,
    conversationId: s.conversationId,
    startSequence: 4,
    endSequence: 6,
  });
  expect(replay.inserted).toBe(0);
  expect(
    await s.db.memoryInteractionLink.count({ where: { conversationId: s.conversationId } }),
  ).toBe(before);
});
