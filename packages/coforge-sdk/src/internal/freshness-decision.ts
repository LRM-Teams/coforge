import { utf8Encoder } from "./text-codec";
/**
 * Raft 1.0.32's freshness-decision producer fact id (`buildApmFreshnessDecisionProducerFactId`,
 * bundle 812372; `stableNormalizeApmHeldFreshness`, 812465).
 *
 * Shared because both sides of a send need the SAME fact id: the server computes it for the
 * decisions it takes, and a daemon that decides a hold locally never reaches the server's code
 * path — yet its activity row and trace must carry the same `freshness_decision_fact:` value for
 * the same decision. The stable input (keys sorted recursively, `undefined` dropped) is what makes
 * two runs agree; `agentId` is part of it, so two Agents making the "same" decision never share an
 * id.
 */

export type FreshnessDecisionAction = "send" | "task_claim" | "task_update";

export type FreshnessDecisionFactInput = {
  agentId: string;
  action?: FreshnessDecisionAction;
  decision: string;
  /** Only ever the literal `"withheld"` in Raft's stable input. */
  freshnessContextMode?: "inline" | "withheld";
  target?: string | null;
  reason: string;
  pendingMaxSeq?: number | null;
  modelSeenSeq?: number | null;
  heldMessageCount?: number | null;
  omittedMessageCount?: number | null;
};

/**
 * Raft 1.0.32 `DEFAULT_HELD_CONTEXT_LIMIT`: how many newer messages a held notice shows. The
 * server puts that many recent messages on a held response, and a daemon that decides a hold
 * locally shows the same number, so both import this one value.
 */
export const HELD_CONTEXT_LIMIT = 3;

/**
 * Raft 1.0.38's `MAX_EXACT_SEQS_PER_TARGET`, which is also its send body's `seenExactSeqs` limit:
 * how many messages above a target's contiguous boundary the daemon remembers the Agent was shown
 * one by one, and how many a send may report. The newest are kept.
 */
export const SEEN_EXACT_SEQS_LIMIT = 2500;

/** Raft 1.0.38's `normalizedExactSeqs`, for input nobody in this process wrote (a file, a request):
 * the distinct positive integers above `after`, ascending, the newest `SEEN_EXACT_SEQS_LIMIT`. */
export function normalizeSeenExactSeqs(values: unknown, after = 0): number[] {
  if (!Array.isArray(values)) return [];
  const kept = new Set<number>();
  for (const value of values)
    if (typeof value === "number" && Number.isSafeInteger(value) && value > after) kept.add(value);
  const sorted = [...kept].sort((left, right) => left - right);
  return sorted.length > SEEN_EXACT_SEQS_LIMIT ? sorted.slice(-SEEN_EXACT_SEQS_LIMIT) : sorted;
}

/**
 * Two ascending lists of exact sequences this process already holds, merged in one pass: each
 * sequence once, only those above `after`, ascending, the newest `SEEN_EXACT_SEQS_LIMIT`.
 */
export function mergeSeenExactSeqs(
  after: number,
  left: readonly number[],
  right: readonly number[],
): number[] {
  const merged: number[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const next =
      j >= right.length || (i < left.length && left[i]! <= right[j]!) ? left[i++]! : right[j++]!;
    if (next > after && next !== merged[merged.length - 1]) merged.push(next);
  }
  const surplus = merged.length - SEEN_EXACT_SEQS_LIMIT;
  if (surplus > 0) merged.splice(0, surplus);
  return merged;
}

/** The largest message sequence: the `sequence` column is a PostgreSQL `integer` (int4). */
export const MAX_MESSAGE_SEQUENCE = 2_147_483_647;

/** A send's `seenExactSeqs`: positive integer sequences a message can have, at most
 * `SEEN_EXACT_SEQS_LIMIT` of them. */
export function isSeenExactSeqs(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= SEEN_EXACT_SEQS_LIMIT &&
    value.every(
      (sequence) => Number.isInteger(sequence) && sequence > 0 && sequence <= MAX_MESSAGE_SEQUENCE,
    )
  );
}

/** Raft's `stableNormalizeApmHeldFreshness`: keys sorted recursively, `undefined` dropped, so the
 * same decision always serializes to the same bytes. */
export function stableNormalizeFreshnessFact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalizeFreshnessFact);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child === undefined) continue;
    normalized[key] = stableNormalizeFreshnessFact(child);
  }
  return normalized;
}

/** The `freshness_decision_fact:` prefix plus the full SHA-256 of the stable decision input. */
export async function freshnessDecisionFactId(input: FreshnessDecisionFactInput): Promise<string> {
  const stableInput = {
    agentId: input.agentId,
    action: input.action ?? "send",
    decision: input.decision,
    ...(input.freshnessContextMode === "withheld"
      ? { freshnessContextMode: "withheld" as const }
      : {}),
    target: input.target ?? null,
    reason: input.reason,
    pendingMaxSeq: input.pendingMaxSeq ?? null,
    modelSeenSeq: input.modelSeenSeq ?? null,
    heldMessageCount: input.heldMessageCount ?? null,
    omittedMessageCount: input.omittedMessageCount ?? null,
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    utf8Encoder.encode(JSON.stringify(stableNormalizeFreshnessFact(stableInput))),
  );
  return `freshness_decision_fact:${toHex(new Uint8Array(digest))}`;
}

/** Lower-case hex, byte for byte what `Buffer.from(digest).toString("hex")` yields (this module
 * also reaches the browser bundle, which has no `Buffer`). */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
