import type { PrismaClient } from "../../../generated/client";
import type { DistillationLlm } from "./distillation-llm.server";
import {
  reserveModelCall,
  resolveWorkspaceModelCredential,
  type ResolvedWorkspaceModelCredential,
} from "./workspace-model-configuration.server";
import { listActiveMemoryInsights } from "./memory-insights.server";
import {
  recentLedgerEntries,
  recordNoActionProposal,
  submitAndAdmitSkillProposal,
  type ProposalDraft,
} from "./skill-proposals.server";

/**
 * The Skill Proposer role (ADR 0052-G): a server-side worker LLM chained
 * after each distillation sweep, on the WikiSkill cadence — exactly one
 * atomic proposal per pass (create / revise / no_action).
 *
 * Its context is deliberately small (the paper's proposer is a ReAct reader;
 * the exploration API serves that role on this stack in slice 4): the active
 * insight heads, the active skill heads, a failure-first sample of recent
 * distilled episodes, and the Proposal Ledger tail — the required reading
 * that keeps rejected approaches from being re-proposed.
 *
 * One LLM call per pass. Output is never trusted: it goes through the
 * canonicalizer (`submitAndAdmitSkillProposal`), which validates the closed
 * schema and the grounding edges before anything binds.
 */

/** Failure-first episode sample into one proposer pass (paper: ≤5 fail + ≤3 pass). */
const PROPOSER_EPISODE_SAMPLE = { maxFailures: 5, maxSuccesses: 3, pool: 20 };
const PROPOSER_SYSTEM = `You are the Skill Proposer of a team's LearnedSkill evolution loop.

You see the team's distilled insights, the currently active learned skills, a
sample of recent collaboration episodes (failures first), and the tail of the
proposal ledger. Decide ONE atomic change — or none:

- "create": a new skill lineage (key, name, kind, full body).
- "revise": a new revision of one existing lineage (target_skill_key, full body).
- "no_action": nothing is warranted.

Kinds and bodies (closed schema, anything else is rejected):
- "step_guidance": {"causal_context":{"facts":[{"fact_id":"f1","statement":"..."}]},
  "branches":[{"branch_id":"b1","when":{"explanation":"observable condition"},
  "action":{"instructions":["do ..."],"rationale":"why"},
  "future":{"disposition":"success|failure_risk","critical_steps":["step"]}}]}
- "procedure": {"preconditions":["..."],"instructions":["1. ..."],"postconditions":["..."]}

Rules:
1. Ground every proposal in real evidence: grounding_episodes is REQUIRED
   (at least one episode id from the sample); grounding_insights optionally
   adds insight heads the skill distills.
2. Read the ledger tail: never re-propose something already rejected there.
3. Prefer revising a partially-correct skill over creating a near-duplicate.
4. Keep bodies concise and actionable; procedures come from successful traces,
   step_guidance branches from failures and recoveries.

Answer with ONE JSON object:
{"action":"create|revise|no_action","reason":"one line",
 "key":"kebab-case-key","name":"Human name","kind":"step_guidance|procedure",
 "target_skill_key":"existing-key","body":{...},
 "grounding_episodes":["<episode-id>"],"grounding_insights":["<insight-id>"]}`;

export type ProposalPassResult = {
  ran: boolean;
  llmCalls: number;
  outcome?: "bound" | "rejected" | "no_action";
  reason?: string;
};

export async function runProposalPass(
  db: PrismaClient,
  llm: DistillationLlm,
  input: {
    workspaceId: string;
    triggerCount: number;
    credential: ResolvedWorkspaceModelCredential;
    now?: Date;
  },
): Promise<ProposalPassResult> {
  const existing = await db.memoryDistillationRun.findUnique({
    where: {
      workspaceId_kind_triggerCount: {
        workspaceId: input.workspaceId,
        kind: "propose",
        triggerCount: input.triggerCount,
      },
    },
    select: { id: true },
  });
  if (existing) return { ran: false, llmCalls: 0 };

  const [insights, skills, episodes, ledger] = await Promise.all([
    listActiveMemoryInsights(db, { workspaceId: input.workspaceId }),
    listActiveSkillHeads(db, input.workspaceId),
    sampleRecentEpisodes(db, input.workspaceId),
    recentLedgerEntries(db, { workspaceId: input.workspaceId }),
  ]);

  const reserve = await reserveModelCall(db, {
    workspaceId: input.workspaceId,
    purpose: "group_memory_proposer",
    now: input.now,
  });
  if (!reserve.allowed) return { ran: false, llmCalls: 0 };

  const payload = await llm.completeJson<unknown>({
    credential: input.credential,
    messages: [
      { role: "system", content: PROPOSER_SYSTEM },
      { role: "user", content: buildProposerUser({ insights, skills, episodes, ledger }) },
    ],
  });
  const llmCalls = 1;
  const draft = parseProposalDraft(payload);

  if (draft.action === "no_action") {
    await recordNoActionProposal(db, {
      workspaceId: input.workspaceId,
      reason: draft.reason,
    });
    await recordProposeRun(db, input.workspaceId, input.triggerCount, llmCalls);
    return { ran: true, llmCalls, outcome: "no_action", reason: draft.reason };
  }

  const verdict = await submitAndAdmitSkillProposal(db, {
    workspaceId: input.workspaceId,
    draft,
    detail: draft.reason,
  });
  await recordProposeRun(db, input.workspaceId, input.triggerCount, llmCalls);
  return {
    ran: true,
    llmCalls,
    outcome: verdict.outcome === "bound" ? "bound" : "rejected",
    reason: verdict.outcome === "rejected" ? verdict.reason : undefined,
  };
}

export async function resolveProposerCredential(db: PrismaClient, workspaceId: string) {
  return resolveWorkspaceModelCredential(db, workspaceId, "group_memory_proposer");
}

type SkillHeadRow = {
  key: string;
  name: string;
  kind: string;
  version: number;
  digest: string;
};

async function listActiveSkillHeads(
  db: PrismaClient,
  workspaceId: string,
): Promise<SkillHeadRow[]> {
  const rows = await db.$queryRaw<SkillHeadRow[]>`
    SELECT s.key, s.name, s.kind, r.version, r."contentDigest" AS digest
    FROM learned_skills s
    JOIN learned_skill_revisions r ON r.id = s."currentRevisionId"
    WHERE s."workspaceId" = ${workspaceId}::uuid AND r.state = 'active'
    ORDER BY s.key
  `;
  return rows;
}

type EpisodeSampleRow = {
  id: string;
  title: string;
  outcome: string | null;
  outcomeReason: string | null;
  keySteps: string | null;
};

async function sampleRecentEpisodes(
  db: PrismaClient,
  workspaceId: string,
): Promise<EpisodeSampleRow[]> {
  const pool = await db.memoryEpisode.findMany({
    where: { workspaceId, distilledAt: { not: null } },
    orderBy: { distilledAt: "desc" },
    take: PROPOSER_EPISODE_SAMPLE.pool,
    select: { id: true, title: true, outcome: true, outcomeReason: true, keySteps: true },
  });
  const failures = pool
    .filter((row) => row.outcome === "failure")
    .slice(0, PROPOSER_EPISODE_SAMPLE.maxFailures);
  const successes = pool
    .filter((row) => row.outcome === "success")
    .slice(0, PROPOSER_EPISODE_SAMPLE.maxSuccesses);
  return [...failures, ...successes];
}

function buildProposerUser(input: {
  insights: Array<{ id: string; statement: string; score: number }>;
  skills: SkillHeadRow[];
  episodes: EpisodeSampleRow[];
  ledger: Array<{ kind: string; payload: unknown; createdAt: Date }>;
}): string {
  const lines: string[] = [];
  lines.push("## Active insights");
  if (input.insights.length === 0) lines.push("(none yet)");
  for (const insight of input.insights)
    lines.push(`- [${insight.id}] ${insight.statement} (score ${insight.score})`);
  lines.push("", "## Active learned skills");
  if (input.skills.length === 0) lines.push("(none yet)");
  for (const skill of input.skills)
    lines.push(
      `- key=${skill.key} kind=${skill.kind} v${skill.version} "${skill.name}" (${skill.digest.slice(0, 16)}…)`,
    );
  lines.push("", "## Recent episodes (failures first)");
  if (input.episodes.length === 0) lines.push("(none distilled yet)");
  for (const episode of input.episodes)
    lines.push(
      `- [${episode.id}] (${episode.outcome}) ${episode.title} — ${episode.outcomeReason ?? ""} :: ${episode.keySteps ?? ""}`,
    );
  lines.push("", "## Proposal ledger (newest first, required reading)");
  if (input.ledger.length === 0) lines.push("(empty)");
  for (const entry of input.ledger) lines.push(`- ${entry.kind}: ${JSON.stringify(entry.payload)}`);
  lines.push("", "Propose ONE atomic change (or no_action).");
  return lines.join("\n");
}

type ParsedDraft = ProposalDraft & { reason?: string };

function parseProposalDraft(payload: unknown): ParsedDraft {
  if (!payload || typeof payload !== "object")
    return { action: "no_action", reason: "proposer payload was not an object" };
  const action = Reflect.get(payload, "action");
  if (action === "no_action")
    return {
      action: "no_action",
      reason:
        typeof Reflect.get(payload, "reason") === "string"
          ? Reflect.get(payload, "reason")
          : undefined,
    };
  if (action !== "create" && action !== "revise")
    return { action: "no_action", reason: "proposer payload had no valid action" };
  const draft: ParsedDraft = { action };
  const reason = Reflect.get(payload, "reason");
  if (typeof reason === "string") draft.reason = reason;
  const key = Reflect.get(payload, "key");
  if (typeof key === "string") draft.key = key;
  const name = Reflect.get(payload, "name");
  if (typeof name === "string") draft.name = name;
  const kind = Reflect.get(payload, "kind");
  if (kind === "step_guidance" || kind === "procedure") draft.kind = kind;
  const targetKey = Reflect.get(payload, "target_skill_key");
  if (typeof targetKey === "string") draft.targetSkillKey = targetKey;
  draft.body = Reflect.get(payload, "body");
  draft.groundingEpisodes = stringArray(Reflect.get(payload, "grounding_episodes"));
  draft.groundingInsights = stringArray(Reflect.get(payload, "grounding_insights"));
  return draft;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

async function recordProposeRun(
  db: PrismaClient,
  workspaceId: string,
  triggerCount: number,
  llmCalls: number,
): Promise<void> {
  try {
    await db.memoryDistillationRun.create({
      data: { workspaceId, kind: "propose", triggerCount, llmCalls },
      select: { id: true },
    });
  } catch {
    // The unique key says this pass already landed — a concurrent sweep won.
  }
}
