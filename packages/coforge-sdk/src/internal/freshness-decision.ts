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
    new TextEncoder().encode(JSON.stringify(stableNormalizeFreshnessFact(stableInput))),
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
