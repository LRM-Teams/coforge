import type { Mechanism } from "./types";

export const MEMORY_TOOLS = ["ov_find", "ov_search_context", "ov_read"] as const;

export function usedMemoryTool(toolsUsed: readonly string[]): boolean {
  return toolsUsed.some((tool) => (MEMORY_TOOLS as readonly string[]).includes(tool));
}

/**
 * The collaboration contract under test: the Task Agent's reply must ride on a
 * cited Memory Offer published by the Memory Agent. A reply with no offer is an
 * ungrounded answer (the Task Agent's session starts with no history, so
 * anything it "recalls" without the offer is fabrication), and any extra
 * Memory-Agent channel message besides the offer is the same send_channel_message
 * leak the public-channel eval fences off.
 */
export function classifyMechanism(input: {
  reply: string | null;
  offerMessageId: string | null;
  citationCount: number;
  memoryLeakMessageIds: readonly string[];
  timedOut?: boolean;
}): { mechanism: Mechanism; headlineEligible: boolean } {
  if (input.timedOut) return { mechanism: "timeout", headlineEligible: false };
  if (input.memoryLeakMessageIds.length > 0) return { mechanism: "leak", headlineEligible: false };
  if (!input.reply?.trim()) return { mechanism: "no_reply", headlineEligible: false };
  if (!input.offerMessageId) return { mechanism: "no_offer", headlineEligible: false };
  if (input.citationCount < 1) return { mechanism: "uncited_offer", headlineEligible: false };
  return { mechanism: "ok", headlineEligible: true };
}
