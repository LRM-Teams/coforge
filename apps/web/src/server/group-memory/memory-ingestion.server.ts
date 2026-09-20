import { RedisClient } from "bun";
import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { getDatabaseClient } from "../db/client.server";
import { admitMemoryEpisode } from "./memory-episodes.server";
import { reconcileMemoryAgentMemberships } from "./memory-agent.server";
import { collectEpisodeParticipants, extractInteractionLinks } from "./memory-interactions.server";

/**
 * Group Memory ingestion (ADR 0052, slice 1).
 *
 * Two triggers feed one admission pipeline (ADR 0052-C):
 *  - `ingestCompletedTask`: a Task that has reached `done`/`closed` admits its
 *    discussion window as a `task` episode. Implemented as a *completion-state
 *    scan*, not an inline TaskBoard hook: the sweep re-discovers completed
 *    Tasks that have no episode yet, so a crash or a lost signal can never
 *    silently drop an episode (the R33 lesson) — it just catches up on the
 *    next tick.
 * *  - `ingestQuietWindow`: once a PublicChannel has been quiet for
 *    MEMORY_QUIET_WINDOW_MS, every message not yet covered by any episode
 *    becomes a `quiet_window` episode. Coverage is per-message, not
 *    "beyond max(endSequence)": a Task window [start, end] leaves earlier
 *    messages uncovered, and those must not be lost to memory.
 *
 * The privacy boundary (ADR 0052-H) is enforced three ways: the candidate
 * scans only ever list PublicChannels (DirectConversations cannot enter the
 * scan set), both ingest entry points independently assert the channel kind,
 * and a DirectConversation reaching an entry point raises ACCESS_DENIED
 * rather than being skipped silently — that path would only be a bug.
 *
 * Episode windows are immutable once admitted: a completed Task that gains
 * more messages before the sweep reaches it admits the wider window once and
 * is then locked ("already_ingested"); the newer messages belong to the next
 * quiet window instead. `admitMemoryEpisode`'s window-key idempotency
 * (the substrate slice) absorbs concurrent replays.
 */

/** How often the sweep looks for newly ingestable work. Batch cadence, not interactive latency. */
export const MEMORY_INGESTION_SWEEP_INTERVAL_MS = 5 * 60_000;
/** A channel is "quiet" once its newest message is at least this old. */
export const MEMORY_QUIET_WINDOW_MS = 30 * 60_000;
/** Bounds one tick's database work regardless of Workspace count. */
const INGESTION_BATCH_LIMIT = 50;
/** Shorter than the interval on purpose, so a slow tick cannot hold the lock into the next one. */
const INGESTION_LOCK_TTL_MS = 4 * 60_000;
const INGESTION_LOCK_KEY = "coforge:group-memory:ingestion-sweep:lock";

export interface MemoryIngestionSweepLock {
  /** Returns true when this instance acquired the lock for the current tick. */
  acquire(instanceId: string): Promise<boolean>;
}

type LockRedisPort = {
  set(key: string, value: string, ...options: Array<string | number>): Promise<unknown>;
};

export class RedisMemoryIngestionSweepLock implements MemoryIngestionSweepLock {
  constructor(private readonly redis: LockRedisPort) {}

  async acquire(instanceId: string): Promise<boolean> {
    const result = await this.redis.set(
      INGESTION_LOCK_KEY,
      instanceId,
      "NX",
      "PX",
      INGESTION_LOCK_TTL_MS,
    );
    return result === "OK";
  }
}

export type IngestedEpisode = { episodeId: string; replayed: boolean };

export type TaskIngestionOutcome =
  | ({ skipped: "already_ingested" } & Partial<IngestedEpisode>)
  | ({ skipped: "not_completed" } & Partial<IngestedEpisode>)
  | ({ skipped: false } & IngestedEpisode);

export type QuietWindowOutcome =
  | ({ skipped: "quiet_window_not_reached" } & Partial<IngestedEpisode>)
  | ({ skipped: "window_empty" } & Partial<IngestedEpisode>)
  | ({ skipped: false } & IngestedEpisode);

/**
 * Snapshot the transcript of a window as stable `name: body` lines. Names use
 * stable handles (usernames / Agent names) because display names can change;
 * `system` covers senderless rows. The exact format is part of the episode's
 * contentHash, so it must stay stable across releases.
 */
export async function collectEpisodeBody(
  db: PrismaClient,
  input: { conversationId: string; startSequence: number; endSequence: number },
): Promise<string> {
  const messages = await db.message.findMany({
    where: {
      conversationId: input.conversationId,
      sequence: { gte: input.startSequence, lte: input.endSequence },
    },
    orderBy: { sequence: "asc" },
    select: {
      body: true,
      sender: {
        select: { user: { select: { username: true } }, agent: { select: { name: true } } },
      },
    },
  });
  return messages
    .map((message) => {
      const name = message.sender?.user?.username ?? message.sender?.agent?.name ?? "system";
      return `${name}: ${message.body}`;
    })
    .join("\n");
}

/**
 * Admit the discussion window of one completed Task (`done`/`closed`).
 *
 * Window = [the Task's root message sequence, the channel's newest message
 * sequence] at first ingestion, then locked: later messages belong to the
 * next quiet window. Idempotent and race-safe via the slice-1 window key.
 */
export async function ingestCompletedTask(
  db: PrismaClient,
  input: { taskMessageId: string },
): Promise<TaskIngestionOutcome> {
  const task = await db.task.findUnique({
    where: { messageId: input.taskMessageId },
    select: {
      messageId: true,
      conversationId: true,
      workspaceId: true,
      title: true,
      status: true,
      message: { select: { sequence: true } },
    },
  });
  if (!task) throw new AppError("NOT_FOUND", { errorId: "gm-ingest-task-missing" });
  if (task.status !== "done" && task.status !== "closed")
    return { skipped: "not_completed", episodeId: undefined };
  await assertPublicChannel(db, task.conversationId);

  const existing = await db.memoryEpisode.findFirst({
    where: { workspaceId: task.workspaceId, taskMessageId: task.messageId },
    select: { id: true },
  });
  if (existing) return { skipped: "already_ingested", episodeId: existing.id };

  const latest = await db.message.findFirst({
    where: { conversationId: task.conversationId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const startSequence = task.message.sequence;
  const endSequence = Math.max(startSequence, latest?.sequence ?? startSequence);
  const participants = await collectEpisodeParticipants(db, {
    conversationId: task.conversationId,
    startSequence,
    endSequence,
  });
  const body = await collectEpisodeBody(db, {
    conversationId: task.conversationId,
    startSequence,
    endSequence,
  });
  const admitted = await admitMemoryEpisode(db, {
    workspaceId: task.workspaceId,
    conversationId: task.conversationId,
    taskMessageId: task.messageId,
    kind: "task",
    startSequence,
    endSequence,
    title: task.title,
    body,
    participants,
  });
  await extractInteractionLinks(db, {
    workspaceId: task.workspaceId,
    conversationId: task.conversationId,
    startSequence,
    endSequence,
  });
  return { skipped: false, ...admitted };
}

/**
 * Admit everything since the last admitted window of a PublicChannel, once
 * the channel has been quiet for MEMORY_QUIET_WINDOW_MS. Skips (rather than
 * errors) while the window is still open or there is nothing new — the sweep
 * calls this on a timer.
 */
export async function ingestQuietWindow(
  db: PrismaClient,
  input: { conversationId: string; now?: number; quietWindowMs?: number },
): Promise<QuietWindowOutcome> {
  const conversation = await db.conversation.findUnique({
    where: { id: input.conversationId },
    select: { id: true, workspaceId: true },
  });
  if (!conversation) throw new AppError("NOT_FOUND", { errorId: "gm-ingest-channel-missing" });
  await assertPublicChannel(db, conversation.id);

  const quietWindowMs = input.quietWindowMs ?? MEMORY_QUIET_WINDOW_MS;
  const latest = await db.message.findFirst({
    where: { conversationId: conversation.id },
    orderBy: { sequence: "desc" },
    select: { sequence: true, createdAt: true },
  });
  if (!latest) return { skipped: "window_empty", episodeId: undefined };

  // Admit every message not covered by any episode yet — a completed Task's
  // window [start, end] can leave earlier messages uncovered, and those must
  // not be lost. Overlap with a Task window's tail is allowed; distillation
  // merges what it sees twice.
  const uncovered = await db.$queryRaw<{ startSequence: number | null }[]>`
    SELECT MIN(m.sequence) AS "startSequence"
    FROM messages m
    WHERE m."conversationId" = ${conversation.id}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM memory_episodes e
        WHERE e."conversationId" = ${conversation.id}::uuid
          AND m.sequence BETWEEN e."startSequence" AND e."endSequence"
      )
  `;
  const startSequence = uncovered[0]?.startSequence ?? null;
  if (startSequence === null) return { skipped: "window_empty", episodeId: undefined };

  const now = input.now ?? Date.now();
  if (now - latest.createdAt.getTime() < quietWindowMs)
    return { skipped: "quiet_window_not_reached", episodeId: undefined };

  const participants = await collectEpisodeParticipants(db, {
    conversationId: conversation.id,
    startSequence,
    endSequence: latest.sequence,
  });
  const body = await collectEpisodeBody(db, {
    conversationId: conversation.id,
    startSequence,
    endSequence: latest.sequence,
  });
  const result = await admitMemoryEpisode(db, {
    workspaceId: conversation.workspaceId,
    conversationId: conversation.id,
    kind: "quiet_window",
    startSequence,
    endSequence: latest.sequence,
    body,
    participants,
  });
  await extractInteractionLinks(db, {
    workspaceId: conversation.workspaceId,
    conversationId: conversation.id,
    startSequence,
    endSequence: latest.sequence,
  });
  return { skipped: false, ...result };
}

/** Completed Tasks on PublicChannels that have no episode yet. */
export async function listIngestableCompletedTasks(
  db: PrismaClient,
  limit = INGESTION_BATCH_LIMIT,
): Promise<Array<{ taskMessageId: string }>> {
  const rows = await db.$queryRaw<{ taskMessageId: string }[]>`
    SELECT t."messageId" AS "taskMessageId"
    FROM tasks t
    JOIN conversations c
      ON c.id = t."conversationId" AND c."workspaceId" = t."workspaceId"
    WHERE t.status IN ('done', 'closed')
      AND c."channelName" IS NOT NULL
      AND t."workspaceId" IN (SELECT "workspaceId" FROM memory_agent_designations)
      AND NOT EXISTS (
        SELECT 1 FROM memory_episodes e WHERE e."taskMessageId" = t."messageId"
      )
    ORDER BY t."updatedAt" ASC
    LIMIT ${limit}
  `;
  return rows;
}

/**
 * PublicChannels whose newest message is older than the quiet threshold and
 * which still have messages not covered by any episode. Quietness is
 * anchored to the newest *sequence*'s createdAt, not MAX(createdAt), so
 * out-of-order timestamps cannot keep a window open forever.
 */
export async function listQuietChannelCandidates(
  db: PrismaClient,
  input: { now: number; quietWindowMs?: number; limit?: number },
): Promise<Array<{ conversationId: string }>> {
  const quietWindowMs = input.quietWindowMs ?? MEMORY_QUIET_WINDOW_MS;
  const limit = input.limit ?? INGESTION_BATCH_LIMIT;
  const cutoff = new Date(input.now - quietWindowMs);
  return db.$queryRaw<{ conversationId: string }[]>`
    SELECT c.id AS "conversationId"
    FROM conversations c
    WHERE c."channelName" IS NOT NULL
      AND c."workspaceId" IN (SELECT "workspaceId" FROM memory_agent_designations)
      AND (
        SELECT m2."createdAt" FROM messages m2
        WHERE m2."conversationId" = c.id
        ORDER BY m2.sequence DESC
        LIMIT 1
      ) < ${cutoff}
      AND EXISTS (
        SELECT 1 FROM messages m
        WHERE m."conversationId" = c.id
          AND NOT EXISTS (
            SELECT 1 FROM memory_episodes e
            WHERE e."conversationId" = c.id
              AND m.sequence BETWEEN e."startSequence" AND e."endSequence"
          )
      )
    ORDER BY c."createdAt" ASC
    LIMIT ${limit}
  `;
}

export class MemoryIngestionSweep {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly db: PrismaClient,
    private readonly lock: MemoryIngestionSweepLock,
    private readonly clock: () => number = Date.now,
    private readonly instanceId: string = crypto.randomUUID(),
    private readonly quietWindowMs: number = MEMORY_QUIET_WINDOW_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), MEMORY_INGESTION_SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Never rejects: this runs off a `setInterval` with no caller to observe a
   * rejection, so every failure is caught and logged (same contract as the
   * Agent activity sweep). Ingestion red line (ADR 0053-E): a failing or
   * absent ingestion never blocks anything — the next tick catches up.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!(await this.lock.acquire(this.instanceId))) return;
      // Derived-state reconciliation before ingesting: the designated Memory
      // Agent must be a member of every PublicChannel (ADR 0052-E), including
      // channels created since enablement.
      await reconcileMemoryAgentMemberships(this.db);
      const tasks = await listIngestableCompletedTasks(this.db);
      const taskResults = await Promise.allSettled(
        tasks.map((task) => ingestCompletedTask(this.db, { taskMessageId: task.taskMessageId })),
      );
      logSettledFailures(
        taskResults,
        tasks.map((task) => ({ task_id: task.taskMessageId })),
      );

      const now = this.clock();
      const candidates = await listQuietChannelCandidates(this.db, {
        now,
        quietWindowMs: this.quietWindowMs,
      });
      const quietResults = await Promise.allSettled(
        candidates.map((candidate) =>
          ingestQuietWindow(this.db, {
            conversationId: candidate.conversationId,
            now,
            quietWindowMs: this.quietWindowMs,
          }),
        ),
      );
      logSettledFailures(
        quietResults,
        candidates.map((candidate) => ({ conversation_id: candidate.conversationId })),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "memory_ingestion_sweep.tick_failed",
          error_type: error instanceof Error ? error.name : typeof error,
        }),
      );
    } finally {
      this.ticking = false;
    }
  }
}

let sweepSingleton: MemoryIngestionSweep | undefined;

/**
 * Idempotent per process. Only the real-traffic composition calls this —
 * same wiring discipline as `ensureAgentActivitySweep` — never a unit test
 * unless the test calls it explicitly.
 */
export function ensureMemoryIngestionSweep(): MemoryIngestionSweep {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required for the Memory ingestion sweep");
  const db = getDatabaseClient();
  if (!db) throw new Error("DATABASE_URL is required for the Memory ingestion sweep");
  sweepSingleton ??= new MemoryIngestionSweep(
    db,
    new RedisMemoryIngestionSweepLock(new RedisClient(redisUrl)),
  );
  sweepSingleton.start();
  return sweepSingleton;
}

async function assertPublicChannel(db: PrismaClient, conversationId: string): Promise<void> {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { channelName: true },
  });
  if (!conversation?.channelName)
    throw new AppError("ACCESS_DENIED", { errorId: "gm-ingest-direct-conversation" });
}

function logSettledFailures(
  results: Array<PromiseSettledResult<unknown>>,
  scopes: Array<Record<string, string>>,
): void {
  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    console.error(
      JSON.stringify({
        event: "memory_ingestion_sweep.scope_failed",
        ...scopes[index],
        error_type: result.reason instanceof Error ? result.reason.name : typeof result.reason,
      }),
    );
  });
}
