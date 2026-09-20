import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";

/**
 * Group Memory storage, slice 1 of ADR 0052: Memory Episode admission.
 *
 * An episode is one admitted, completed slice of PublicChannel collaboration
 * (a Task's discussion window, or a channel quiet window as the fallback
 * trigger). Episodes are immutable evidence: admission is keyed by
 * (workspace, conversation, kind, sequence bounds) so that a byte-identical
 * replay of the same window maps to the same row, while content drift under
 * the same window key is rejected — and a Task re-open, which always produces
 * a new window, admits a *new* episode instead of mutating the old one.
 *
 * Only the distillation worker (ADR 0052-B) and the ingestion
 * triggers (slice 2) call into this module. Nothing here mutates an admitted
 * row; the sole in-place update path is `recordMemoryEpisodeDistillation`
 * for the distillation pass's outcome stamp.
 */

export type MemoryEpisodeKind = "task" | "quiet_window";

/** One window participant: an Agent or a human, by stable identity (ADR 0052-C). */
export type EpisodeParticipant = {
  kind: "agent" | "human";
  /** agentId for kind=agent, userId for kind=human. */
  id: string;
  /** Immutable handle: Agent name or user username. */
  handle: string;
};

export function normalizeEpisodeParticipants(
  participants: EpisodeParticipant[] | undefined | null,
): EpisodeParticipant[] {
  const seen = new Set<string>();
  const unique = (participants ?? []).filter((participant) => {
    const key = `${participant.kind}:${participant.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort((a, b) =>
    a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind),
  );
}

export type MemoryEpisodeAdmission = {
  workspaceId: string;
  conversationId: string;
  /** The Task's message id for task episodes; null for quiet windows. */
  taskMessageId?: string | null;
  kind: MemoryEpisodeKind;
  /** Inclusive message-sequence bounds of the admitted window. */
  startSequence: number;
  endSequence: number;
  /** Provisional label; the distillation pass may enrich it later. */
  title?: string;
  /** Transcript snapshot. Immutable after admission. */
  body: string;
  /** Structured participants snapshot (ADR 0052-C); normalized into the content hash. */
  participants?: EpisodeParticipant[];
};

export type MemoryEpisodeAdmissionResult = {
  episodeId: string;
  /** True when this call mapped onto an already-admitted row (idempotent replay). */
  replayed: boolean;
};

const EPISODE_KINDS = new Set<MemoryEpisodeKind>(["task", "quiet_window"]);

/**
 * sha256 over the canonical admission payload. Field order is fixed and
 * participants are normalized (sorted, deduplicated), so logically identical
 * admissions hash identically regardless of how the caller constructed the
 * input object.
 */
export function hashEpisodeContent(admission: MemoryEpisodeAdmission): string {
  const canonical = JSON.stringify([
    admission.conversationId,
    admission.taskMessageId ?? null,
    admission.kind,
    admission.startSequence,
    admission.endSequence,
    admission.title ?? "",
    admission.body,
    normalizeEpisodeParticipants(admission.participants),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function assertAdmission(admission: MemoryEpisodeAdmission): void {
  if (!EPISODE_KINDS.has(admission.kind))
    throw new AppError("INVALID_INPUT", { errorId: "gm-episode-kind" });
  if (!Number.isInteger(admission.startSequence) || !Number.isInteger(admission.endSequence))
    throw new AppError("INVALID_INPUT", { errorId: "gm-episode-bounds" });
  if (admission.startSequence < 1 || admission.endSequence < admission.startSequence)
    throw new AppError("INVALID_INPUT", { errorId: "gm-episode-bounds" });
  if (admission.body.trim().length === 0)
    throw new AppError("INVALID_INPUT", { errorId: "gm-episode-empty" });
}

/**
 * Admit (or idempotently re-admit) one episode window.
 *
 * - Fresh window → new immutable row.
 * - Byte-identical replay of an admitted window → the existing row
 *   (`replayed: true`), no new row, no mutation.
 * - Same window key with *different* content → `AppError("CONFLICT")`:
 *   the caller's snapshot disagrees with history; the window must be widened
 *   and re-admitted under a new end bound, never silently overwritten.
 */
export async function admitMemoryEpisode(
  db: PrismaClient,
  admission: MemoryEpisodeAdmission,
): Promise<MemoryEpisodeAdmissionResult> {
  assertAdmission(admission);
  const contentHash = hashEpisodeContent(admission);
  const participants = normalizeEpisodeParticipants(admission.participants);
  try {
    const episode = await db.memoryEpisode.create({
      data: {
        workspaceId: admission.workspaceId,
        conversationId: admission.conversationId,
        taskMessageId: admission.taskMessageId ?? null,
        kind: admission.kind,
        startSequence: admission.startSequence,
        endSequence: admission.endSequence,
        title: admission.title ?? "",
        body: admission.body,
        contentHash,
        participants: participants as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { episodeId: episode.id, replayed: false };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
  }
  const existing = await db.memoryEpisode.findUnique({
    where: {
      workspaceId_conversationId_kind_startSequence_endSequence: {
        workspaceId: admission.workspaceId,
        conversationId: admission.conversationId,
        kind: admission.kind,
        startSequence: admission.startSequence,
        endSequence: admission.endSequence,
      },
    },
    select: { id: true, contentHash: true },
  });
  if (!existing) throw new AppError("CONFLICT", { errorId: "gm-episode-race" });
  if (existing.contentHash !== contentHash)
    throw new AppError("CONFLICT", { errorId: "gm-episode-drift" });
  return { episodeId: existing.id, replayed: true };
}

/**
 * Stamp the distillation pass's LLM-inferred outcome (ADR 0053-B) on an
 * admitted episode. Idempotent: re-stamping the same outcome is a no-op;
 * stamping a *different* outcome over an existing one is a conflict (the
 * pass that produced it must be auditable, not overwritten).
 */
export async function recordMemoryEpisodeDistillation(
  db: PrismaClient,
  input: {
    episodeId: string;
    outcome: "success" | "failure";
    outcomeReason?: string;
    keySteps?: string;
    title?: string;
  },
): Promise<void> {
  const updated = await db.memoryEpisode.updateMany({
    where: {
      id: input.episodeId,
      OR: [{ outcome: null }, { outcome: input.outcome }],
    },
    data: {
      outcome: input.outcome,
      outcomeReason: input.outcomeReason ?? null,
      keySteps: input.keySteps ?? null,
      distilledAt: new Date(),
      ...(input.title ? { title: input.title } : {}),
    },
  });
  if (updated.count !== 1) throw new AppError("CONFLICT", { errorId: "gm-episode-outcome" });
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}
