import type { Mechanism } from "./types";

export const MEMORY_TOOLS = ["ov_find", "ov_search_context", "ov_read"] as const;

/**
 * The collaboration contract under test: the Task Agent may only execute with
 * a cited Memory Offer carrying the skill. An execution without an offer means
 * the skill never arrived through team memory; a Memory-Agent channel message
 * besides the offer is the send_channel_message leak the product fences off.
 * (The task verdict itself comes from pytest, not from the reply text.)
 */
export function classifyMechanism(input: {
  reply: string | null;
  offerMessageId: string | null;
  citationCount: number;
  memoryLeakMessageIds: readonly string[];
  timedOut?: boolean;
}): { mechanism: Mechanism; headlineEligible: boolean } {
  if (input.memoryLeakMessageIds.length > 0) return { mechanism: "leak", headlineEligible: false };
  if (!input.offerMessageId) return { mechanism: "no_offer", headlineEligible: false };
  if (input.citationCount < 1) return { mechanism: "uncited_offer", headlineEligible: false };
  if (!input.reply?.trim()) return { mechanism: "no_reply", headlineEligible: false };
  if (input.timedOut) return { mechanism: "timeout", headlineEligible: true };
  return { mechanism: "ok", headlineEligible: true };
}
