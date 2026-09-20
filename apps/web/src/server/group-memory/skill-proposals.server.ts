import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import {
  buildSkillSearchText,
  skillArtifactDigest,
  validateSkillArtifactBody,
  validateSkillKey,
  validateSkillName,
  type SkillArtifactBody,
  type SkillArtifactKind,
} from "./skill-artifacts.server";

/**
 * Skill Proposal admission — the canonicalizer boundary (ADR 0052-D/F).
 *
 * The proposer is an LLM writer; nothing it emits is authoritative until it
 * passes here. Admission validates the closed body schema and the grounding
 * edges (at least one *episode* grounding for every kind — procedure skills
 * descend from the successful traces they were distilled from, step_guidance
 * from traces and optionally insights), then binds atomically:
 *
 *  - create: new lineage + revision v1 as the head;
 *  - revise: revision v(max+1) with the supersedes edge onto the current
 *    head, which becomes the new head.
 *
 * Verdicts land in the Proposal Ledger in the same transaction as the state
 * change. Shadow gating means admission never judges *usefulness* — only
 * schema and provenance validity; outcomes adjust scores later (slice 5).
 */

export type ProposalAction = "create" | "revise" | "no_action";

export type ProposalDraft = {
  action: ProposalAction;
  /** create only: lineage key, display name, artifact kind. */
  key?: string;
  name?: string;
  kind?: SkillArtifactKind;
  /** create/revise: the artifact body (validated here, never trusted). */
  body?: unknown;
  /** Grounding provenance edges: episode ids (required ≥1) and insight head ids. */
  groundingEpisodes?: string[];
  groundingInsights?: string[];
  /** revise only: address the lineage by key or id (one required). */
  targetSkillKey?: string;
  targetSkillId?: string;
  /** revise only: build on this revision; must be the current head. */
  parentRevisionId?: string;
};

export type AdmissionResult =
  | { outcome: "bound"; proposalId: string; revisionId: string; version: number }
  | { outcome: "rejected"; proposalId: string; reason: string };

const LEDGER_CONTEXT_LIMIT = 20;

/**
 * Append one Proposal Ledger entry. The ledger is the proposer's required
 * reading (ADR 0052-D): rejected and retired proposals stay in full.
 */
export async function appendLedgerEntry(
  db: Prisma.TransactionClient | PrismaClient,
  input: {
    workspaceId: string;
    kind: "proposed" | "no_action" | "admitted" | "rejected" | "bound" | "signal" | "retired";
    proposalId?: string;
    revisionId?: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await db.skillProposalLedgerEntry.create({
    data: {
      workspaceId: input.workspaceId,
      kind: input.kind,
      proposalId: input.proposalId ?? null,
      revisionId: input.revisionId ?? null,
      payload: input.payload as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
}

/** The proposer's required context: recent ledger entries, newest first. */
export async function recentLedgerEntries(
  db: PrismaClient,
  input: { workspaceId: string; limit?: number },
) {
  return db.skillProposalLedgerEntry.findMany({
    where: { workspaceId: input.workspaceId },
    orderBy: { createdAt: "desc" },
    take: input.limit ?? LEDGER_CONTEXT_LIMIT,
    select: { kind: true, payload: true, createdAt: true },
  });
}

/** Record a no_action pass — the loop's audit trail keeps these too. */
export async function recordNoActionProposal(
  db: PrismaClient,
  input: { workspaceId: string; reason?: string },
): Promise<void> {
  await appendLedgerEntry(db, {
    workspaceId: input.workspaceId,
    kind: "no_action",
    payload: { reason: input.reason ?? "proposer found nothing to propose" },
  });
}

/**
 * Submit + admit one atomic proposal (the single entry point the proposer
 * worker calls). All-or-none: the proposal row, its grounding edges, the
 * verdict ledger entries, and (on success) the revision + head move commit
 * in one transaction. A schema or provenance violation leaves a rejected
 * proposal row plus the ledger entry.
 */
export async function submitAndAdmitSkillProposal(
  db: PrismaClient,
  input: { workspaceId: string; draft: ProposalDraft; detail?: string },
): Promise<AdmissionResult> {
  const { draft } = input;
  if (draft.action === "no_action") {
    await recordNoActionProposal(db, {
      workspaceId: input.workspaceId,
      reason: typeof draft.body === "string" ? draft.body : undefined,
    });
    return { outcome: "rejected", proposalId: "", reason: "no_action" };
  }
  if (draft.action !== "create" && draft.action !== "revise")
    return { outcome: "rejected", proposalId: "", reason: "ls-proposal-action" };

  return db.$transaction(async (tx) => {
    const proposal = await tx.skillProposal.create({
      data: {
        workspaceId: input.workspaceId,
        action: draft.action,
        proposedBody: draft.body === undefined ? undefined : (draft.body as Prisma.InputJsonValue),
        status: "proposed",
      },
      select: { id: true },
    });
    await appendLedgerEntry(tx, {
      workspaceId: input.workspaceId,
      kind: "proposed",
      proposalId: proposal.id,
      payload: { action: draft.action, detail: input.detail ?? null },
    });
    return validateAndBind(tx, { workspaceId: input.workspaceId, proposalId: proposal.id, draft });
  });
}

type SkillRow = {
  id: string;
  workspaceId: string;
  kind: string;
  key: string;
  name: string;
  currentRevisionId: string | null;
};

async function validateAndBind(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; proposalId: string; draft: ProposalDraft },
): Promise<AdmissionResult> {
  const { draft } = input;
  const reject = async (reason: string): Promise<AdmissionResult> => {
    await tx.skillProposal.update({
      where: { id: input.proposalId },
      data: { status: "rejected", rejectionReason: reason },
      select: { id: true },
    });
    await appendLedgerEntry(tx, {
      workspaceId: input.workspaceId,
      kind: "rejected",
      proposalId: input.proposalId,
      payload: { reason },
    });
    return { outcome: "rejected", proposalId: input.proposalId, reason };
  };

  // Resolve the lineage first so the body validates against its immutable kind.
  let skill: SkillRow;
  let parentRevision: { id: string; version: number } | null = null;
  if (draft.action === "create") {
    try {
      validateSkillKey(draft.key ?? "");
      validateSkillName(draft.name ?? "");
    } catch {
      return reject("ls-artifact-key");
    }
    const existing = await tx.learnedSkill.findUnique({
      where: { workspaceId_key: { workspaceId: input.workspaceId, key: draft.key! } },
      select: { id: true },
    });
    if (existing) return reject("ls-proposal-key-exists");
    skill = await tx.learnedSkill.create({
      data: {
        workspaceId: input.workspaceId,
        key: draft.key!,
        name: draft.name!,
        kind: draft.kind ?? "step_guidance",
      },
      select: skillSelect,
    });
  } else {
    if (!draft.targetSkillKey && !draft.targetSkillId) return reject("ls-proposal-target-missing");
    const row = draft.targetSkillId
      ? await tx.learnedSkill.findUnique({
          where: { id: draft.targetSkillId },
          select: skillSelect,
        })
      : await tx.learnedSkill.findUnique({
          where: {
            workspaceId_key: { workspaceId: input.workspaceId, key: draft.targetSkillKey! },
          },
          select: skillSelect,
        });
    if (!row || row.workspaceId !== input.workspaceId) return reject("ls-proposal-target-missing");
    skill = row;
    parentRevision = skill.currentRevisionId
      ? await tx.learnedSkillRevision.findUnique({
          where: { id: skill.currentRevisionId },
          select: { id: true, version: true, skillId: true },
        })
      : null;
    if (draft.parentRevisionId) {
      if (!parentRevision || draft.parentRevisionId !== parentRevision.id)
        return reject("ls-proposal-parent-not-head");
    }
  }

  // Schema gate — against the lineage's kind.
  let body: SkillArtifactBody;
  try {
    body = validateSkillArtifactBody(skill.kind as SkillArtifactKind, draft.body);
  } catch (error) {
    const reason =
      error instanceof AppError && error.errorId ? error.errorId : "ls-proposal-invalid";
    return reject(reason);
  }

  // Provenance gate: every kind requires ≥1 episode grounding.
  const episodeIds = [...new Set(draft.groundingEpisodes ?? [])];
  const insightIds = [...new Set(draft.groundingInsights ?? [])];
  if (episodeIds.length < 1) return reject("ls-proposal-no-episode-grounding");
  const episodeRows = await tx.memoryEpisode.findMany({
    where: { id: { in: episodeIds }, workspaceId: input.workspaceId },
    select: { id: true },
  });
  if (episodeRows.length !== episodeIds.length)
    return reject("ls-proposal-grounding-episode-missing");
  const insightRows = insightIds.length
    ? await tx.memoryInsight.findMany({
        where: { id: { in: insightIds }, workspaceId: input.workspaceId, supersededById: null },
        select: { id: true },
      })
    : [];
  if (insightRows.length !== insightIds.length)
    return reject("ls-proposal-grounding-insight-missing");

  // Version is the lineage maximum + 1 (monotonic, never reused — a revise
  // after retirement still counts history).
  const maxRow = await tx.learnedSkillRevision.findFirst({
    where: { skillId: skill.id },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (maxRow?.version ?? 0) + 1;
  const kind = skill.kind as SkillArtifactKind;
  const digest = skillArtifactDigest(kind, body);

  try {
    const revision = await tx.learnedSkillRevision.create({
      data: {
        workspaceId: input.workspaceId,
        skillId: skill.id,
        version,
        body: body as unknown as Prisma.InputJsonValue,
        contentDigest: digest,
        parentRevisionId: parentRevision?.id ?? null,
        proposalId: input.proposalId,
        searchText: buildSkillSearchText(skill.name, kind, body),
      },
      select: { id: true },
    });
    await tx.skillProposal.update({
      where: { id: input.proposalId },
      data: {
        status: "bound",
        targetSkillId: skill.id,
        parentRevisionId: parentRevision?.id ?? null,
      },
      select: { id: true },
    });
    for (const episodeId of episodeIds) {
      await tx.skillProposalGrounding.create({
        data: {
          workspaceId: input.workspaceId,
          proposalId: input.proposalId,
          kind: "episode",
          targetKey: `episode:${episodeId}`,
          episodeId,
        },
        select: { id: true },
      });
    }
    for (const insightId of insightIds) {
      await tx.skillProposalGrounding.create({
        data: {
          workspaceId: input.workspaceId,
          proposalId: input.proposalId,
          kind: "insight",
          targetKey: `insight:${insightId}`,
          insightId,
        },
        select: { id: true },
      });
    }
    await tx.learnedSkill.update({
      where: { id: skill.id },
      data: { currentRevisionId: revision.id },
      select: { id: true },
    });
    await tx.learnedSkillScoreEvent.create({
      data: {
        workspaceId: input.workspaceId,
        revisionId: revision.id,
        delta: 2,
        reason: "seed",
        operationKey: `seed:${revision.id}`,
      },
      select: { id: true },
    });
    await appendLedgerEntry(tx, {
      workspaceId: input.workspaceId,
      kind: "bound",
      proposalId: input.proposalId,
      revisionId: revision.id,
      payload: { skillKey: skill.key, version, digest, action: draft.action },
    });
    return { outcome: "bound", proposalId: input.proposalId, revisionId: revision.id, version };
  } catch (error) {
    if (isUniqueConflict(error)) return reject("ls-proposal-version-race");
    throw error;
  }
}

const skillSelect = {
  id: true,
  workspaceId: true,
  kind: true,
  key: true,
  name: true,
  currentRevisionId: true,
} as const;

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}
