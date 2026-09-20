import { RedisClient } from "bun";
import type { PrismaClient } from "../../../generated/client";
import { getDatabaseClient } from "../db/client.server";
import { recordMemoryEpisodeDistillation } from "./memory-episodes.server";
import {
  createMemoryInsight,
  linkMemoryEpisodesToInsight,
  listActiveMemoryInsights,
  liveMemoryScore,
  mergeMemoryInsights,
  recordMemoryScoreEvent,
  reviseMemoryInsight,
  type ActiveMemoryInsight,
} from "./memory-insights.server";
import {
  buildCritiqueCompareMessages,
  buildCritiqueSuccessMessages,
  buildMergeRulesMessages,
  buildOutcomeMessages,
  CRITIQUE_RULES_FULL_THRESHOLD,
  type CritiqueOperation,
  type OutcomeVerdict,
} from "./distillation-prompts.server";
import { DistillationLlmError, type DistillationLlm } from "./distillation-llm.server";
import { runProposalPass } from "./skill-proposer.server";
import { runShadowGateSweep } from "./shadow-gate.server";
import {
  reserveModelCall,
  resolveWorkspaceModelCredential,
  type ResolvedWorkspaceModelCredential,
} from "./workspace-model-configuration.server";

/**
 * Group Memory distillation worker — the Wiki-Maintainer role (ADR 0052-B/G).
 *
 * One server-side writer, the graph memory rhythm, ported:
 *  - every admitted episode gets one outcome pass (LLM-inferred success |
 *    failure + reason + key-steps digest — CoForge has no environment reward);
 *  - every CRITIQUE_CADENCE distilled episodes, a critique pass applies
 *    AGREE/REMOVE/EDIT/ADD operations over active insights (scores via
 *    append-only events; REMOVE weighs -3 when the rule set is full, else -1);
 *  - every MERGE_CADENCE distilled episodes, a merge pass consolidates
 *    similar insight pairs found through the trigram similarity seam.
 *
 * Port deviations, all recorded deliberately:
 *  - the reference method anchors critique passes on random stored tasks;
 *    CoForge anchors on the most recent distilled episodes — random is
 *    untestable, recent is equivalent for a batch cadence;
 *  - the reference method clears scores <= 0 outright and resets merged rules
 *    to score 2; CoForge retires (never deletes) and merge passes keep the
 *    absorbed chain's score history — auditability over the reference's
 *    list-rewrite;
 *  - the reference method clusters tasks with FINCH before merging; CoForge
 *    pairs insights directly through the trigram similarity seam — no derived
 *    graph projection exists on this stack (ADR 0052, Rejected alternatives);
 *  - the critique window is stratified failure-first (ADR 0052-G, after the
 *    WikiSkill paper's ≤5 fail + ≤3 pass sampling): failures carry the
 *    lessons, successes fill the window and guard against regression.
 *
 * Budget red line (ADR 0052-G): every model call goes through
 * `reserveModelCall` first; a Workspace out of budget pauses distillation
 * entirely (outcome, critique, and merge alike) until the UTC day rolls over.
 * A failed pass leaves no run row, so the next sweep retries it; every
 * operation that did land is idempotent by its score-event operation key.
 */

export const MEMORY_DISTILLATION_SWEEP_INTERVAL_MS = 10 * 60_000;
const EPISODE_BATCH = 10;
/** Episodes per critique pass (reference default: rounds_per_insights = 5). */
export const CRITIQUE_CADENCE = 5;
/** Episodes per merge pass (reference default: 20). */
export const MERGE_CADENCE = 20;
/** Episodes feeding one critique pass (reference: insights_point_num = 5). */
const CRITIQUE_WINDOW = 5;
/** Candidate pool the failure-first stratified window is drawn from. */
const CRITIQUE_POOL = 20;
/** Lowest trigram similarity at which the merge pass considers an insight pair. */
const MIN_MERGE_SIMILARITY = 0.45;
const DISTILLATION_LOCK_TTL_MS = 9 * 60_000;
const DISTILLATION_LOCK_KEY = "coforge:group-memory:distillation-sweep:lock";

type DistillationLockRedisPort = {
  set(key: string, value: string, ...options: Array<string | number>): Promise<unknown>;
};

export async function distillPendingEpisodes(
  db: PrismaClient,
  llm: DistillationLlm,
  input: { workspaceId: string; credential: ResolvedWorkspaceModelCredential; now?: Date },
): Promise<{ distilled: number; budgetExhausted: boolean }> {
  const episodes = await db.memoryEpisode.findMany({
    where: { workspaceId: input.workspaceId, distilledAt: null },
    orderBy: { createdAt: "asc" },
    take: EPISODE_BATCH,
    select: { id: true, title: true, body: true },
  });
  let distilled = 0;
  for (const episode of episodes) {
    const result = await distillOneEpisode(db, llm, {
      episode,
      workspaceId: input.workspaceId,
      credential: input.credential,
      now: input.now,
    });
    if (result === "budget") return { distilled, budgetExhausted: true };
    distilled += 1;
  }
  return { distilled, budgetExhausted: false };
}

async function distillOneEpisode(
  db: PrismaClient,
  llm: DistillationLlm,
  input: {
    episode: { id: string; title: string; body: string };
    workspaceId: string;
    credential: ResolvedWorkspaceModelCredential;
    now?: Date;
  },
): Promise<"distilled" | "budget"> {
  const reserve = await reserveModelCall(db, {
    workspaceId: input.workspaceId,
    purpose: "group_memory_distillation",
    now: input.now,
  });
  if (!reserve.allowed) return "budget";
  const verdict = parseOutcomeVerdict(
    await llm.completeJson<OutcomeVerdict>({
      credential: input.credential,
      messages: buildOutcomeMessages({
        episodeTitle: input.episode.title,
        transcript: input.episode.body,
      }),
    }),
  );
  await recordMemoryEpisodeDistillation(db, {
    episodeId: input.episode.id,
    outcome: verdict.outcome,
    outcomeReason: verdict.reason,
    keySteps: verdict.keySteps,
  });
  return "distilled";
}

export async function runCritiquePass(
  db: PrismaClient,
  llm: DistillationLlm,
  input: {
    workspaceId: string;
    triggerCount: number;
    credential: ResolvedWorkspaceModelCredential;
    now?: Date;
  },
): Promise<{ ran: boolean; llmCalls: number }> {
  const runKey = `critique:${input.triggerCount}`;
  if (await distillationRunExists(db, input.workspaceId, "critique", input.triggerCount))
    return { ran: false, llmCalls: 0 };

  // Failure-first stratified window (ADR 0052-G): from the most recent
  // distilled episodes take failures first, then successes, up to the window.
  const pool = await db.memoryEpisode.findMany({
    where: { workspaceId: input.workspaceId, distilledAt: { not: null } },
    orderBy: { distilledAt: "desc" },
    take: CRITIQUE_POOL,
    select: {
      id: true,
      title: true,
      outcome: true,
      outcomeReason: true,
      keySteps: true,
      distilledAt: true,
    },
  });
  const failuresNewest = pool.filter((episode) => episode.outcome === "failure");
  const successesNewest = pool.filter((episode) => episode.outcome === "success");
  const window = [
    ...failuresNewest.slice(0, CRITIQUE_WINDOW),
    ...successesNewest.slice(0, Math.max(0, CRITIQUE_WINDOW - failuresNewest.length)),
  ];
  const recent = [...window].reverse();
  const successes = recent.filter((episode) => episode.outcome === "success");
  const failures = recent.filter((episode) => episode.outcome === "failure");
  if (recent.length === 0) return { ran: false, llmCalls: 0 };

  let llmCalls = 0;
  const pairs = Math.min(failures.length, successes.length);
  for (let index = 0; index < pairs; index++) {
    const failure = failures[index]!;
    const success = successes[index]!;
    const active = await listActiveMemoryInsights(db, { workspaceId: input.workspaceId });
    const existingRules = active.map((insight) => insight.statement);
    const rulesFull = active.length >= CRITIQUE_RULES_FULL_THRESHOLD;
    const budget = await reserveOnce(db, input);
    if (!budget) return { ran: false, llmCalls };
    llmCalls += 1;
    const operations = parseCritiqueOperations(
      await llm.completeJson<{ operations: CritiqueOperation[] }>({
        credential: input.credential,
        messages: buildCritiqueCompareMessages({
          successCase: { title: success.title, keySteps: success.keySteps ?? success.title },
          failureCase: {
            title: failure.title,
            reason: failure.outcomeReason ?? "unknown",
            keySteps: failure.keySteps ?? failure.title,
          },
          existingRules,
          rulesFull,
        }),
      }),
      active.length,
    );
    await applyCritiqueOperations(db, {
      workspaceId: input.workspaceId,
      operations,
      active,
      relatedEpisodes: recent.map((episode) => episode.id),
      rulesFull,
      runKey: `${runKey}:compare:${index}`,
    });
  }

  if (successes.length > 0) {
    const active = await listActiveMemoryInsights(db, { workspaceId: input.workspaceId });
    const existingRules = active.map((insight) => insight.statement);
    const rulesFull = active.length >= CRITIQUE_RULES_FULL_THRESHOLD;
    const budget = await reserveOnce(db, input);
    if (!budget) return { ran: false, llmCalls };
    llmCalls += 1;
    const operations = parseCritiqueOperations(
      await llm.completeJson<{ operations: CritiqueOperation[] }>({
        credential: input.credential,
        messages: buildCritiqueSuccessMessages({
          successCases: successes.map((episode) => ({
            title: episode.title,
            keySteps: episode.keySteps ?? episode.title,
          })),
          existingRules,
          rulesFull,
        }),
      }),
      active.length,
    );
    await applyCritiqueOperations(db, {
      workspaceId: input.workspaceId,
      operations,
      active,
      relatedEpisodes: recent.map((episode) => episode.id),
      rulesFull,
      runKey: `${runKey}:success`,
    });
  }

  await recordDistillationRun(db, input.workspaceId, "critique", input.triggerCount, llmCalls);
  return { ran: true, llmCalls };
}

export async function runMergePass(
  db: PrismaClient,
  llm: DistillationLlm,
  input: {
    workspaceId: string;
    triggerCount: number;
    credential: ResolvedWorkspaceModelCredential;
    now?: Date;
  },
): Promise<{ ran: boolean; llmCalls: number }> {
  if (await distillationRunExists(db, input.workspaceId, "merge", input.triggerCount))
    return { ran: false, llmCalls: 0 };

  const pairs = await similarInsightPairs(db, input.workspaceId);
  const statements = await insightStatements(db, input.workspaceId);
  let llmCalls = 0;
  const merged = new Set<string>();
  for (const edge of pairs) {
    if (merged.has(edge.leftId) || merged.has(edge.rightId)) continue;
    const left = statements.get(edge.leftId);
    const right = statements.get(edge.rightId);
    if (!left || !right) continue;
    const budget = await reserveOnce(db, input);
    if (!budget) return { ran: false, llmCalls };
    llmCalls += 1;
    const payload = await llm.completeJson<{ merged: string[] }>({
      credential: input.credential,
      messages: buildMergeRulesMessages({ rules: [left, right], limit: 1 }),
    });
    const statement = (payload?.merged ?? [])[0];
    if (typeof statement !== "string" || !statement.trim()) continue;
    const survivorIsLeft =
      (await liveMemoryScore(db, {
        workspaceId: input.workspaceId,
        insightId: edge.leftId,
      })) >=
      (await liveMemoryScore(db, { workspaceId: input.workspaceId, insightId: edge.rightId }));
    const survivorId = survivorIsLeft ? edge.leftId : edge.rightId;
    const absorbedId = survivorIsLeft ? edge.rightId : edge.leftId;
    await mergeMemoryInsights(db, {
      workspaceId: input.workspaceId,
      survivorId,
      absorbedIds: [absorbedId],
      statement: statement.trim(),
    });
    merged.add(edge.leftId);
    merged.add(edge.rightId);
  }
  await recordDistillationRun(db, input.workspaceId, "merge", input.triggerCount, llmCalls);
  return { ran: true, llmCalls };
}

/**
 * One sweep over every Workspace with a model configuration. Never rejects
 * (interval host); a Workspace without a configuration is skipped — its
 * distillation stays paused while retrieval keeps serving (ADR 0052-E).
 */
export async function sweepMemoryDistillation(
  db: PrismaClient,
  llm: DistillationLlm,
  input: { now?: Date } = {},
): Promise<void> {
  // Group Memory runs only where enabled: the designation row is the switch
  // (ADR 0054-H), so distillation joins it onto the model configurations.
  const configs = await db.workspaceModelConfiguration.findMany({
    where: { workspace: { memoryAgentDesignation: { isNot: null } } },
    select: { workspaceId: true },
    orderBy: { createdAt: "asc" },
  });
  for (const config of configs) {
    const credential = await resolveWorkspaceModelCredential(
      db,
      config.workspaceId,
      "group_memory_distillation",
    );
    if (!credential) continue;
    try {
      const outcome = await distillPendingEpisodes(db, llm, {
        workspaceId: config.workspaceId,
        credential,
        now: input.now,
      });
      if (outcome.budgetExhausted) {
        console.error(
          JSON.stringify({
            event: "memory_distillation.budget_exhausted",
            workspace_id: config.workspaceId,
          }),
        );
        continue;
      }
      const distilledCount = await db.memoryEpisode.count({
        where: { workspaceId: config.workspaceId, distilledAt: { not: null } },
      });
      if (distilledCount >= CRITIQUE_CADENCE && distilledCount % CRITIQUE_CADENCE === 0) {
        await runCritiquePass(db, llm, {
          workspaceId: config.workspaceId,
          triggerCount: distilledCount / CRITIQUE_CADENCE,
          credential,
          now: input.now,
        });
      }
      if (distilledCount >= MERGE_CADENCE && distilledCount % MERGE_CADENCE === 0) {
        await runMergePass(db, llm, {
          workspaceId: config.workspaceId,
          triggerCount: distilledCount / MERGE_CADENCE,
          credential,
          now: input.now,
        });
      }
      // Distill→propose sweep chain (ADR 0052-G): one atomic proposal per
      // pass, chained after the cadence passes. Trigger-count idempotency
      // means an unchanged distilled count never re-proposes.
      if (distilledCount > 0) {
        await runProposalPass(db, llm, {
          workspaceId: config.workspaceId,
          triggerCount: distilledCount,
          credential,
          now: input.now,
        });
      }
      // The shadow gate is deterministic and LLM-free: delivery→outcome
      // signals and retirement run every sweep (ADR 0052-D).
      await runShadowGateSweep(db, { workspaceId: config.workspaceId, now: input.now });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "memory_distillation.workspace_failed",
          workspace_id: config.workspaceId,
          error_type: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
  }
}

async function applyCritiqueOperations(
  db: PrismaClient,
  input: {
    workspaceId: string;
    operations: CritiqueOperation[];
    active: ActiveMemoryInsight[];
    relatedEpisodes: string[];
    rulesFull: boolean;
    runKey: string;
  },
): Promise<void> {
  const touched = new Set<string>();
  const order: CritiqueOperation["op"][] = ["REMOVE", "AGREE", "EDIT", "ADD"];
  const byOrder = new Map(input.operations.map((operation, index) => [index, operation]));
  for (const phase of order) {
    for (const [index, operation] of byOrder) {
      if (operation.op !== phase) continue;
      const operationKey = `${input.runKey}:op:${index}`;
      if (operation.op === "ADD") {
        if (input.active.some((insight) => insight.statement.includes(operation.statement)))
          continue;
        await createMemoryInsight(db, {
          workspaceId: input.workspaceId,
          statement: operation.statement,
          initialScore: 2,
          episodeLinks: input.relatedEpisodes.map((episodeId) => ({
            episodeId,
            polarity: "positive" as const,
          })),
        });
        continue;
      }
      const insight = input.active[operation.index - 1];
      if (!insight || touched.has(insight.id)) continue;
      touched.add(insight.id);
      const links = input.relatedEpisodes.map((episodeId) => ({
        episodeId,
        polarity: (operation.op === "REMOVE" ? "negative" : "positive") as "negative" | "positive",
      }));
      if (operation.op === "REMOVE") {
        await recordMemoryScoreEvent(db, {
          workspaceId: input.workspaceId,
          insightId: insight.id,
          delta: input.rulesFull ? -3 : -1,
          reason: "critique_remove",
          operationKey,
        });
        await linkMemoryEpisodesToInsight(db, {
          workspaceId: input.workspaceId,
          insightId: insight.id,
          links,
        });
      } else if (operation.op === "AGREE") {
        await recordMemoryScoreEvent(db, {
          workspaceId: input.workspaceId,
          insightId: insight.id,
          delta: 1,
          reason: "critique_agree",
          operationKey,
        });
        await linkMemoryEpisodesToInsight(db, {
          workspaceId: input.workspaceId,
          insightId: insight.id,
          links,
        });
      } else if (operation.op === "EDIT") {
        const { revisionId } = await reviseMemoryInsight(db, {
          workspaceId: input.workspaceId,
          insightId: insight.id,
          statement: operation.statement,
        });
        await recordMemoryScoreEvent(db, {
          workspaceId: input.workspaceId,
          insightId: revisionId,
          delta: 1,
          reason: "critique_edit",
          operationKey,
        });
        await linkMemoryEpisodesToInsight(db, {
          workspaceId: input.workspaceId,
          insightId: revisionId,
          links: links.map((link) => ({ ...link, polarity: "positive" as const })),
        });
      }
    }
  }
}

function parseOutcomeVerdict(payload: unknown): OutcomeVerdict {
  if (!payload || typeof payload !== "object")
    throw new DistillationLlmError("outcome payload was not an object");
  const outcome = Reflect.get(payload, "outcome");
  const reason = Reflect.get(payload, "reason");
  const keySteps = Reflect.get(payload, "keySteps");
  if (outcome !== "success" && outcome !== "failure")
    throw new DistillationLlmError("outcome payload had no valid outcome");
  if (typeof reason !== "string" || !reason.trim())
    throw new DistillationLlmError("outcome payload had no reason");
  if (typeof keySteps !== "string" || !keySteps.trim())
    throw new DistillationLlmError("outcome payload had no keySteps");
  return { outcome, reason: reason.trim(), keySteps: keySteps.trim() };
}

function parseCritiqueOperations(payload: unknown, activeCount: number): CritiqueOperation[] {
  if (!payload || typeof payload !== "object")
    throw new DistillationLlmError("critique payload was not an object");
  const operations = Reflect.get(payload, "operations");
  if (!Array.isArray(operations))
    throw new DistillationLlmError("critique payload had no operations");
  const parsed: CritiqueOperation[] = [];
  for (const entry of operations) {
    if (!entry || typeof entry !== "object") continue;
    const op = Reflect.get(entry, "op");
    const statement = Reflect.get(entry, "statement");
    const index = Reflect.get(entry, "index");
    if (op === "ADD" && typeof statement === "string" && statement.trim().length > 0) {
      parsed.push({ op: "ADD", statement: statement.trim() });
    } else if (
      op === "EDIT" &&
      isRuleIndex(index, activeCount) &&
      typeof statement === "string" &&
      statement.trim().length > 0
    ) {
      parsed.push({ op: "EDIT", index: index as number, statement: statement.trim() });
    } else if (op === "AGREE" && isRuleIndex(index, activeCount)) {
      parsed.push({ op: "AGREE", index: index as number });
    } else if (op === "REMOVE" && isRuleIndex(index, activeCount)) {
      parsed.push({ op: "REMOVE", index: index as number });
    }
  }
  return parsed.slice(0, 4);
}

function isRuleIndex(value: unknown, activeCount: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= activeCount;
}

async function reserveOnce(
  db: PrismaClient,
  input: { workspaceId: string; now?: Date },
): Promise<boolean> {
  const reserve = await reserveModelCall(db, {
    workspaceId: input.workspaceId,
    purpose: "group_memory_distillation",
    now: input.now,
  });
  return reserve.allowed;
}

/** Most-similar active insight-head pairs via the trigram seam (no graph projection). */
async function similarInsightPairs(
  db: PrismaClient,
  workspaceId: string,
): Promise<Array<{ leftId: string; rightId: string; similarity: number }>> {
  const rows = await db.$queryRaw<Array<{ leftId: string; rightId: string; similarity: number }>>`
    WITH heads AS (
      SELECT h.id, h.statement FROM memory_insights h
      WHERE h."workspaceId" = ${workspaceId}::uuid AND h."supersededById" IS NULL
    )
    SELECT a.id AS "leftId", b.id AS "rightId",
           word_similarity(a.statement, b.statement) AS similarity
    FROM heads a JOIN heads b ON a.id < b.id
    WHERE word_similarity(a.statement, b.statement) >= ${MIN_MERGE_SIMILARITY}
    ORDER BY similarity DESC, a.id
    LIMIT 10
  `;
  return rows;
}

async function insightStatements(
  db: PrismaClient,
  workspaceId: string,
): Promise<Map<string, string>> {
  const rows = await db.memoryInsight.findMany({
    where: { workspaceId, supersededById: null },
    select: { id: true, statement: true },
  });
  return new Map(rows.map((row) => [row.id, row.statement]));
}

async function distillationRunExists(
  db: PrismaClient,
  workspaceId: string,
  kind: "critique" | "merge",
  triggerCount: number,
): Promise<boolean> {
  const row = await db.memoryDistillationRun.findUnique({
    where: { workspaceId_kind_triggerCount: { workspaceId, kind, triggerCount } },
    select: { id: true },
  });
  return row !== null;
}

async function recordDistillationRun(
  db: PrismaClient,
  workspaceId: string,
  kind: "critique" | "merge",
  triggerCount: number,
  llmCalls: number,
): Promise<void> {
  try {
    await db.memoryDistillationRun.create({
      data: { workspaceId, kind, triggerCount, llmCalls },
      select: { id: true },
    });
  } catch {
    // The unique key says this pass already landed — a concurrent sweep won.
  }
}

export class MemoryDistillationSweep {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly db: PrismaClient,
    private readonly llm: DistillationLlm,
    private readonly lock: { acquire(instanceId: string): Promise<boolean> },
    private readonly clock: () => Date = () => new Date(),
    private readonly instanceId: string = crypto.randomUUID(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), MEMORY_DISTILLATION_SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!(await this.lock.acquire(this.instanceId))) return;
      await sweepMemoryDistillation(this.db, this.llm, { now: this.clock() });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "memory_distillation_sweep.tick_failed",
          error_type: error instanceof Error ? error.name : typeof error,
        }),
      );
    } finally {
      this.ticking = false;
    }
  }
}

let distillationSingleton: MemoryDistillationSweep | undefined;

/**
 * Idempotent per process; real-traffic composition wiring, same discipline as
 * the ingestion sweep. Only one instance may hold the Redis lock per tick, so
 * multiple web instances share the cadence without double-distilling.
 */
export function ensureMemoryDistillationSweep(llm: DistillationLlm): MemoryDistillationSweep {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required for the Memory distillation sweep");
  const db = getDatabaseClient();
  if (!db) throw new Error("DATABASE_URL is required for the Memory distillation sweep");
  distillationSingleton ??= new MemoryDistillationSweep(db, llm, {
    acquire: async (instanceId) => {
      const client: DistillationLockRedisPort = new RedisClient(redisUrl);
      const result = await client.set(
        DISTILLATION_LOCK_KEY,
        instanceId,
        "NX",
        "PX",
        DISTILLATION_LOCK_TTL_MS,
      );
      return result === "OK";
    },
  });
  distillationSingleton.start();
  return distillationSingleton;
}
