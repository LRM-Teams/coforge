import type { PrismaClient } from "../../../generated/client";
import { appendLedgerEntry } from "./skill-proposals.server";

/**
 * The shadow gate (ADR 0052-D, slice 5): no grader exists in a product
 * environment, so a bound LearnedSkill revision's worth is measured by what
 * happens after the Memory Agent offers it.
 *
 * Deterministic, LLM-free, one sweep pass:
 *
 *  - for every delivered *skill* offer, find episodes admitted after the
 *    delivery whose participants include the receiving Agent and whose
 *    outcome was distilled — each such (delivery, episode) pair applies one
 *    signed score event (+1 success / −1 failure), idempotent by its
 *    operation key, so replays and re-sweeps never double-count;
 *  - a revision whose live score (sum of its events) drops to <= 0 retires:
 *    state flips, the lineage head falls back to its parent revision when
 *    that parent is still active, else the lineage is headless until a new
 *    revise proposal — and the retirement lands in the Proposal Ledger.
 *
 * Signals are deliberately weak (±1) and unattributed beyond participation:
 * an episode has many causes; the gate only needs the aggregate trend.
 * Insight deliveries are out of scope here — insights already carry their
 * own critique/task score events.
 */

const SIGNAL_WINDOW_DAYS = 14;

export type ShadowGateSweepResult = {
  signalsApplied: number;
  retired: number;
};

export async function runShadowGateSweep(
  db: PrismaClient,
  input: { workspaceId: string; now?: Date },
): Promise<ShadowGateSweepResult> {
  const now = input.now ?? new Date();
  const deliveries = await db.memoryOfferDelivery.findMany({
    where: {
      workspaceId: input.workspaceId,
      targetKind: "skill",
      skillRevisionId: { not: null },
      deliveredAt: { gte: new Date(now.getTime() - SIGNAL_WINDOW_DAYS * 24 * 60 * 60_000) },
    },
    select: { id: true, agentId: true, skillRevisionId: true, deliveredAt: true },
  });

  let signalsApplied = 0;
  for (const delivery of deliveries) {
    const candidates = await db.$queryRaw<Array<{ id: string; outcome: string }>>`
      SELECT e.id, e.outcome FROM memory_episodes e
      WHERE e."workspaceId" = ${input.workspaceId}::uuid
        AND e.outcome IS NOT NULL
         AND e."createdAt" > ${delivery.deliveredAt}
        AND e.participants @> jsonb_build_array(jsonb_build_object('kind', 'agent', 'id', ${delivery.agentId}::text))
    `;
    for (const episode of candidates) {
      if (episode.outcome !== "success" && episode.outcome !== "failure") continue;
      const operationKey = `signal:${delivery.id}:${episode.id}`;
      const existing = await db.learnedSkillScoreEvent.findUnique({
        where: { workspaceId_operationKey: { workspaceId: input.workspaceId, operationKey } },
        select: { id: true },
      });
      if (existing) continue;
      const delta = episode.outcome === "success" ? 1 : -1;
      await db.learnedSkillScoreEvent.create({
        data: {
          workspaceId: input.workspaceId,
          revisionId: delivery.skillRevisionId!,
          delta,
          reason: episode.outcome === "success" ? "offer_signal_success" : "offer_signal_failure",
          detail: `episode ${episode.id} after delivery ${delivery.id}`,
          operationKey,
          offerDeliveryId: delivery.id,
        },
        select: { id: true },
      });
      await appendLedgerEntry(db, {
        workspaceId: input.workspaceId,
        kind: "signal",
        revisionId: delivery.skillRevisionId!,
        payload: {
          delta,
          outcome: episode.outcome,
          episodeId: episode.id,
          deliveryId: delivery.id,
        },
      });
      signalsApplied += 1;
    }
  }

  const retired = await retireExhaustedRevisions(db, input.workspaceId);
  return { signalsApplied, retired };
}

/** Live score per revision = sum of its score events; retire at <= 0. */
async function retireExhaustedRevisions(db: PrismaClient, workspaceId: string): Promise<number> {
  const rows = await db.$queryRaw<
    Array<{ id: string; skillId: string; parentRevisionId: string | null }>
  >`
    SELECT r.id, r."skillId", r."parentRevisionId"
    FROM learned_skill_revisions r
    LEFT JOIN learned_skill_score_events e ON e."revisionId" = r.id
    WHERE r."workspaceId" = ${workspaceId}::uuid AND r.state = 'active'
    GROUP BY r.id, r."skillId", r."parentRevisionId"
    HAVING COALESCE(SUM(e.delta), 0) <= 0
  `;
  let retired = 0;
  for (const row of rows) {
    // Seed events start a revision at +2, so <= 0 means real negative signal.
    const outcome = await db.$transaction(async (tx) => {
      const flipped = await tx.learnedSkillRevision.updateMany({
        where: { id: row.id, state: "active" },
        data: { state: "retired" },
      });
      if (flipped.count !== 1) return false;
      let headId: string | null = null;
      if (row.parentRevisionId) {
        const parent = await tx.learnedSkillRevision.findUnique({
          where: { id: row.parentRevisionId },
          select: { id: true, state: true },
        });
        if (parent?.state === "active") headId = parent.id;
      }
      await tx.learnedSkill.updateMany({
        where: { id: row.skillId, currentRevisionId: row.id },
        data: { currentRevisionId: headId },
      });
      await appendLedgerEntry(tx, {
        workspaceId,
        kind: "retired",
        revisionId: row.id,
        payload: { reason: "shadow gate: live score fell to <= 0", headFellBackTo: headId },
      });
      return true;
    });
    if (outcome) retired += 1;
  }
  return retired;
}
