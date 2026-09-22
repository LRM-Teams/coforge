import type { Mechanism } from "./types";

export const MEMORY_TOOLS = [
  "ov_find",
  "ov_search_context",
  "ov_read",
  "causal_search",
  "causal_trace",
  "causal_intervention",
] as const;

export const LEAK_ONLY_TOOLS = ["message_read"] as const;

export function usedMemoryTool(toolsUsed: readonly string[]): boolean {
  return toolsUsed.some((tool) => (MEMORY_TOOLS as readonly string[]).includes(tool));
}

export function usedOnlyLeakTools(toolsUsed: readonly string[]): boolean {
  if (toolsUsed.length === 0) return false;
  return toolsUsed.every((tool) => (LEAK_ONLY_TOOLS as readonly string[]).includes(tool));
}

export function classifyMechanism(input: {
  reply: string | null;
  offerMessageId: string | null;
  citationCount: number;
  toolsUsed: readonly string[];
  timedOut?: boolean;
}): { mechanism: Mechanism; headlineEligible: boolean } {
  if (input.timedOut) return { mechanism: "timeout", headlineEligible: false };
  if (!input.reply?.trim()) return { mechanism: "no_reply", headlineEligible: false };
  if (usedOnlyLeakTools(input.toolsUsed) && !usedMemoryTool(input.toolsUsed)) {
    return { mechanism: "leak", headlineEligible: false };
  }
  if (!input.offerMessageId) return { mechanism: "no_offer", headlineEligible: false };
  if (input.citationCount < 1) return { mechanism: "uncited_offer", headlineEligible: false };
  if (!usedMemoryTool(input.toolsUsed) && input.citationCount < 1) {
    return { mechanism: "leak", headlineEligible: false };
  }
  return { mechanism: "ok", headlineEligible: true };
}
