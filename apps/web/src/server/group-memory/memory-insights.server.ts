import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";

/**
 * Group Memory storage, slice 1 of ADR 0052: Memory Insight lifecycle.
 *
 * A Memory Insight is a *chain* of immutable rows: an EDIT or merge inserts a
 * new revision and points the old row's `supersededById` at it. The chain head
 * (`supersededById IS NULL`) is the live insight; superseded rows stay as
 * audit history and are excluded from retrieval.
 *
 * Scores are append-only MemoryScoreEvent rows (ADR 0052-B). The live score of
 * a chain is the sum of events attached to *any* member row, so a merge
 * carries the absorbed chain's history into the surviving head without ever
 * rewriting a row. A head whose live score is <= 0 is retired: excluded from
 * the active list and from similarity seeds, never deleted.
 */

export type MemoryInsightPolarity = "positive" | "negative";

export type MemoryScoreReason =
  | "seed"
  | "task_success"
  | "task_failure"
  | "critique_add"
  | "critique_agree"
  | "critique_edit"
  | "critique_remove"
  | "merge";

export type MemoryInsightEpisodeLinkInput = {
  episodeId: string;
  polarity: MemoryInsightPolarity;
};

const SCORE_REASONS = new Set<string>([
  "seed",
  "task_success",
  "task_failure",
  "critique_add",
  "critique_agree",
  "critique_edit",
  "critique_remove",
  "merge",
]);

const POLARITIES = new Set<string>(["positive", "negative"]);

export async function createMemoryInsight(
  db: PrismaClient,
  input: {
    workspaceId: string;
    statement: string;
    /** Episodes that support (positive) or contradict (negative) the insight. */
    episodeLinks?: MemoryInsightEpisodeLinkInput[];
    /** Initial score seeded via a `seed` score event. Default 1. */
    initialScore?: number;
  },
): Promise<{ insightId: string }> {
  assertStatement(input.statement);
  assertLinks(input.episodeLinks ?? []);
  const initialScore = input.initialScore ?? 1;
  if (!Number.isInteger(initialScore) || initialScore < 0)
    throw new AppError("INVALID_INPUT", { errorId: "gm-insight-score" });

  return db.$transaction(async (tx) => {
    const insight = await tx.memoryInsight.create({
      data: { workspaceId: input.workspaceId, statement: input.statement },
      select: { id: true },
    });
    await tx.memoryScoreEvent.create({
      data: {
        workspaceId: input.workspaceId,
        insightId: insight.id,
        delta: initialScore,
        reason: "seed",
        operationKey: `seed:${insight.id}`,
      },
    });
    if (input.episodeLinks?.length)
      await linkEpisodes(tx, input.workspaceId, insight.id, input.episodeLinks);
    return { insightId: insight.id };
  });
}

/**
 * Revise a chain head (the reference method EDIT critique, ported to immutable
 * rows): insert a new revision, point the old head at it, and carry the head's
 * episode links forward. Score history follows automatically because live
 * score sums the whole chain. Revising a non-head row is a conflict.
 */
export async function reviseMemoryInsight(
  db: PrismaClient,
  input: { workspaceId: string; insightId: string; statement: string },
): Promise<{ revisionId: string }> {
  assertStatement(input.statement);
  return db.$transaction(async (tx) => {
    const current = await tx.memoryInsight.findUnique({
      where: { id: input.insightId },
      select: { id: true, workspaceId: true, supersededById: true },
    });
    if (!current || current.workspaceId !== input.workspaceId)
      throw new AppError("NOT_FOUND", { errorId: "gm-insight-missing" });
    if (current.supersededById) throw new AppError("CONFLICT", { errorId: "gm-insight-not-head" });

    const revision = await tx.memoryInsight.create({
      data: { workspaceId: input.workspaceId, statement: input.statement },
      select: { id: true },
    });
    const moved = await tx.memoryInsight.updateMany({
      where: { id: current.id, supersededById: null },
      data: { supersededById: revision.id },
    });
    if (moved.count !== 1) throw new AppError("CONFLICT", { errorId: "gm-insight-revise-race" });
    const links = await tx.memoryInsightEpisodeLink.findMany({
      where: { insightId: current.id },
      select: { episodeId: true, polarity: true },
    });
    if (links.length)
      await linkEpisodes(
        tx,
        input.workspaceId,
        revision.id,
        links.map((link) => ({
          episodeId: link.episodeId,
          polarity: link.polarity as MemoryInsightPolarity,
        })),
      );
    return { revisionId: revision.id };
  });
}

/**
 * Merge absorbed insight chains into a surviving head (the reference method merge
 * pass, ported): create one revision on the survivor's chain with the merged
 * statement, then supersede every absorbed head by that revision. Because the
 * absorbed rows join the survivor's chain as ancestors of the revision, their
 * score events and episode links carry into the surviving head with zero
 * rewrites.
 *
 * Structurally idempotent: an absorbed insight that is already superseded by
 * a row in the survivor's chain is a replay (skipped, no new revision); one
 * superseded into a *different* chain is a conflict. A pure replay (nothing
 * new to absorb) returns the surviving head and rejects a statement that
 * disagrees with it.
 */
export async function mergeMemoryInsights(
  db: PrismaClient,
  input: {
    workspaceId: string;
    survivorId: string;
    absorbedIds: string[];
    statement: string;
  },
): Promise<{ revisionId: string }> {
  assertStatement(input.statement);
  const absorbedIds = [...new Set(input.absorbedIds)];
  return db.$transaction(async (tx) => {
    const survivor = await tx.memoryInsight.findUnique({
      where: { id: input.survivorId },
      select: { id: true, workspaceId: true, supersededById: true, statement: true },
    });
    if (!survivor || survivor.workspaceId !== input.workspaceId)
      throw new AppError("NOT_FOUND", { errorId: "gm-insight-missing" });
    if (survivor.supersededById) throw new AppError("CONFLICT", { errorId: "gm-insight-not-head" });

    const toMerge: string[] = [];
    for (const absorbedId of absorbedIds) {
      if (absorbedId === survivor.id) continue;
      const row = await tx.memoryInsight.findUnique({
        where: { id: absorbedId },
        select: { id: true, workspaceId: true, supersededById: true },
      });
      if (!row || row.workspaceId !== input.workspaceId)
        throw new AppError("NOT_FOUND", { errorId: "gm-insight-missing" });
      if (!row.supersededById) {
        toMerge.push(row.id);
        continue;
      }
      const headId = await headOfChain(tx, row.supersededById);
      if (headId !== survivor.id)
        throw new AppError("CONFLICT", { errorId: "gm-merge-foreign-chain" });
    }

    if (toMerge.length === 0) {
      if (survivor.statement !== input.statement)
        throw new AppError("CONFLICT", { errorId: "gm-merge-replay-drift" });
      return { revisionId: survivor.id };
    }

    const revision = await tx.memoryInsight.create({
      data: { workspaceId: input.workspaceId, statement: input.statement },
      select: { id: true },
    });
    const carryLinks: MemoryInsightEpisodeLinkInput[] = [];
    for (const insightId of [survivor.id, ...toMerge]) {
      const links = await tx.memoryInsightEpisodeLink.findMany({
        where: { insightId },
        select: { episodeId: true, polarity: true },
      });
      carryLinks.push(
        ...links.map((link) => ({
          episodeId: link.episodeId,
          polarity: link.polarity as MemoryInsightPolarity,
        })),
      );
    }
    await linkEpisodes(tx, input.workspaceId, revision.id, carryLinks);

    const moved = await tx.memoryInsight.updateMany({
      where: { id: survivor.id, supersededById: null },
      data: { supersededById: revision.id },
    });
    if (moved.count !== 1) throw new AppError("CONFLICT", { errorId: "gm-merge-race" });
    for (const absorbedId of toMerge) {
      const absorbed = await tx.memoryInsight.updateMany({
        where: { id: absorbedId, supersededById: null },
        data: { supersededById: revision.id },
      });
      if (absorbed.count !== 1) throw new AppError("CONFLICT", { errorId: "gm-merge-race" });
    }
    return { revisionId: revision.id };
  });
}

/**
 * Append one score adjustment event. Idempotent by caller operation key: a
 * byte-identical replay maps to the existing event; the same key with a
 * different payload is a conflict (ADR 0053 value semantics).
 */
export async function recordMemoryScoreEvent(
  db: PrismaClient,
  input: {
    workspaceId: string;
    insightId: string;
    delta: number;
    reason: MemoryScoreReason;
    detail?: string;
    operationKey: string;
    /** Task provenance when the delta comes from a task outcome. */
    taskId?: string;
  },
): Promise<{ eventId: string; replayed: boolean }> {
  if (!Number.isInteger(input.delta) || input.delta === 0)
    throw new AppError("INVALID_INPUT", { errorId: "gm-score-delta" });
  if (!SCORE_REASONS.has(input.reason))
    throw new AppError("INVALID_INPUT", { errorId: "gm-score-reason" });
  if (!input.operationKey || input.operationKey.length > 200)
    throw new AppError("INVALID_INPUT", { errorId: "gm-score-key" });

  try {
    const event = await db.memoryScoreEvent.create({
      data: {
        workspaceId: input.workspaceId,
        insightId: input.insightId,
        delta: input.delta,
        reason: input.reason,
        detail: input.detail ?? null,
        operationKey: input.operationKey,
        taskId: input.taskId ?? null,
      },
      select: { id: true },
    });
    return { eventId: event.id, replayed: false };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
  }
  const existing = await db.memoryScoreEvent.findUnique({
    where: {
      workspaceId_operationKey: {
        workspaceId: input.workspaceId,
        operationKey: input.operationKey,
      },
    },
    select: { id: true, insightId: true, delta: true, reason: true },
  });
  if (
    !existing ||
    existing.insightId !== input.insightId ||
    existing.delta !== input.delta ||
    existing.reason !== input.reason
  )
    throw new AppError("CONFLICT", { errorId: "gm-score-drift" });
  return { eventId: existing.id, replayed: true };
}

/** Live score of the chain containing `insightId`: the sum of all score events over all its member rows. */
export async function liveMemoryScore(
  db: PrismaClient,
  input: { workspaceId: string; insightId: string },
): Promise<number> {
  const rows = await db.$queryRaw<{ score: number }[]>`
    WITH RECURSIVE forward AS (
      SELECT m.id, m."supersededById" FROM memory_insights m
      WHERE m."workspaceId" = ${input.workspaceId}::uuid AND m.id = ${input.insightId}::uuid
      UNION
      SELECT m.id, m."supersededById" FROM memory_insights m
      JOIN forward f ON m.id = f."supersededById"
    ),
    chain AS (
      SELECT f.id AS "memberId" FROM forward f WHERE f."supersededById" IS NULL
      UNION
      SELECT m.id FROM memory_insights m
      JOIN chain c ON m."supersededById" = c."memberId"
    )
    SELECT COALESCE(SUM(e.delta), 0)::int AS score
    FROM chain c LEFT JOIN memory_score_events e ON e."insightId" = c."memberId"
  `;
  return rows[0]?.score ?? 0;
}

export type ActiveMemoryInsight = {
  id: string;
  statement: string;
  score: number;
};

/**
 * Retrieval set for a Workspace: chain heads whose live score is > 0.
 * Superseded rows and retired heads are absent by definition (ADR 0052-B).
 */
export async function listActiveMemoryInsights(
  db: PrismaClient,
  input: { workspaceId: string },
): Promise<ActiveMemoryInsight[]> {
  return db.$queryRaw<ActiveMemoryInsight[]>`
    WITH RECURSIVE chain AS (
      SELECT h.id AS "memberId", h.id AS "headId", h.statement AS statement
      FROM memory_insights h
      WHERE h."workspaceId" = ${input.workspaceId}::uuid AND h."supersededById" IS NULL
      UNION
      SELECT m.id, c."headId", m.statement
      FROM memory_insights m JOIN chain c ON m."supersededById" = c."memberId"
    ),
    scores AS (
      SELECT c."headId" AS "headId", COALESCE(SUM(e.delta), 0)::int AS score
      FROM chain c LEFT JOIN memory_score_events e ON e."insightId" = c."memberId"
      GROUP BY c."headId"
    )
    SELECT c."headId" AS id, c.statement AS statement, s.score AS score
    FROM chain c JOIN scores s ON s."headId" = c."headId"
    WHERE c."memberId" = c."headId" AND s.score > 0
    ORDER BY s.score DESC, c.statement ASC
  `;
}

/**
 * Attach episodes to an insight head (distillation output; authoritative —
 * distinct from the derived graph edges). Idempotent per (insight, episode).
 */
export async function linkMemoryEpisodesToInsight(
  db: PrismaClient,
  input: { workspaceId: string; insightId: string; links: MemoryInsightEpisodeLinkInput[] },
): Promise<{ linked: number }> {
  assertLinks(input.links);
  const linked = await linkEpisodes(db, input.workspaceId, input.insightId, input.links);
  return { linked };
}

async function linkEpisodes(
  db: Prisma.TransactionClient,
  workspaceId: string,
  insightId: string,
  links: MemoryInsightEpisodeLinkInput[],
): Promise<number> {
  if (!links.length) return 0;
  const result = await db.memoryInsightEpisodeLink.createMany({
    data: links.map((link) => ({
      workspaceId,
      insightId,
      episodeId: link.episodeId,
      polarity: link.polarity,
    })),
    skipDuplicates: true,
  });
  return result.count;
}

async function headOfChain(
  db: Prisma.TransactionClient,
  insightId: string,
): Promise<string | null> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE forward AS (
      SELECT m.id, m."supersededById" FROM memory_insights m WHERE m.id = ${insightId}::uuid
      UNION
      SELECT m.id, m."supersededById" FROM memory_insights m
      JOIN forward f ON m.id = f."supersededById"
    )
    SELECT id FROM forward WHERE "supersededById" IS NULL
  `;
  return rows[0]?.id ?? null;
}

function assertStatement(statement: string): void {
  if (typeof statement !== "string" || statement.trim().length === 0 || statement.length > 2000)
    throw new AppError("INVALID_INPUT", { errorId: "gm-insight-statement" });
}

function assertLinks(links: MemoryInsightEpisodeLinkInput[]): void {
  for (const link of links) {
    if (!POLARITIES.has(link.polarity))
      throw new AppError("INVALID_INPUT", { errorId: "gm-link-polarity" });
  }
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}
