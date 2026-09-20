/**
 * Distillation prompts — the graph memory reference method (arXiv 2506.07398,
 * `prompt.py` / `GMemory.py`) ported to CoForge's Group Memory.
 *
 * Port fidelity notes (recorded per ADR 0053/0055 discipline):
 *  - The critique semantics are kept verbatim in spirit: AGREE / REMOVE /
 *    EDIT / ADD operations over existing rules, "at most 4 operations, each
 *    existing rule at most 1 operation", the `rules full` suffix that suppresses
 *    ADD when the rule set is large, the "XXX, because XXX" insight format,
 *    and the merge pass's "strictly based on the given inputs" rule.
 *  - The reference implementation parses its operations out of free text with
 *    a regex; CoForge requires **JSON** output from the model instead. Same
 *    semantics, machine-checked format — a deliberate port adjustment, not a
 *    behavior change.
 *  - The reference method derives labels and fail reasons from a game
 *    environment; CoForge has no environment reward, so the outcome (success |
 *    failure), the failure reason, and the key-steps digest come from one
 *    model call over the admitted episode transcript (ADR 0053-B).
 */

export type DistillationMessages = Array<{ role: "system" | "user"; content: string }>;

export type CritiqueOperation =
  | { op: "ADD"; statement: string }
  | { op: "AGREE"; index: number }
  | { op: "EDIT"; index: number; statement: string }
  | { op: "REMOVE"; index: number };

export type OutcomeVerdict = {
  outcome: "success" | "failure";
  reason: string;
  keySteps: string;
};

/** Mirrors the reference method's max-rule threshold for the "suppress ADD" suffix. */
export const CRITIQUE_RULES_FULL_THRESHOLD = 10;

export function buildOutcomeMessages(input: {
  episodeTitle: string;
  transcript: string;
}): DistillationMessages {
  return [
    {
      role: "system",
      content: `You are an analytical agent reviewing one completed slice of team collaboration from a group chat channel. Members may be humans or agents. Your job is to judge how the work ended and to extract the steps that mattered.

Rules:
- Judge success by whether the collaborators' own words indicate the work reached its goal (a deliverable was produced, verified, merged, shipped, or explicitly closed), not by how much activity happened.
- Judge failure when the work stalled, was abandoned, was re-opened because it did not hold, or the participants state it did not work out.
- The reason must be a concise causal sentence. For failures, name the mistake or the breakdown point. For successes, name why it worked.
- The key steps must be a short digest of the decisive actions, in order, without narration.

Respond with JSON only:
{"outcome": "success" | "failure", "reason": string, "keySteps": string}`,
    },
    {
      role: "user",
      content: `## Collaboration slice
${input.episodeTitle || "(untitled window)"}

## Transcript
${input.transcript}

Your JSON verdict:`,
    },
  ];
}

export function buildCritiqueSuccessMessages(input: {
  successCases: Array<{ title: string; keySteps: string }>;
  existingRules: string[];
  rulesFull: boolean;
}): DistillationMessages {
  return [
    { role: "system", content: critiqueSystemPrompt(input.rulesFull) },
    {
      role: "user",
      content: `## Requirements:
- Avoid vague statements; ensure each insight has a clear causal relationship.
- Focus only on strategies that apply to a broad range of this team's work rather than case-specific advice.
- Keep the language concise and to the point, ensuring clarity and practical value.
- The insights must follow the "XXX, because XXX" format: a general principle, then the reason it holds. Never mention the specific trials; rules must be GENERALLY APPLICABLE.

## Examples:
- Eliminate unnecessary detours in planning, because focusing on core objectives improves execution efficiency.

## Here are the completed collaboration slices:
${input.successCases
  .map((slice, index) => `### Slice ${index + 1}: ${slice.title}\nKey steps: ${slice.keySteps}`)
  .join("\n\n")}

## Here are the EXISTING RULES (numbered — reference them by index):
${numberedRules(input.existingRules)}

By examining the completed slices and the list of existing rules, choose operations so the new list of rules is a set of GENERAL and HIGH LEVEL insights useful for the team's future work.

Respond with JSON only, in this shape:
{"operations": [{"op": "ADD", "statement": "..."} | {"op": "AGREE", "index": 1} | {"op": "EDIT", "index": 2, "statement": "..."} | {"op": "REMOVE", "index": 3}]}
Do at most 4 operations, and each existing rule can get at most 1 operation. Any existing rule not edited, not agreed, nor removed is considered copied.`,
    },
  ];
}

export function buildCritiqueCompareMessages(input: {
  successCase: { title: string; keySteps: string };
  failureCase: { title: string; reason: string; keySteps: string };
  existingRules: string[];
  rulesFull: boolean;
}): DistillationMessages {
  return [
    { role: "system", content: critiqueSystemPrompt(input.rulesFull) },
    {
      role: "user",
      content: `## Requirements:
- Convert the reasons for failure into insights for future collaborators, in order to avoid making the same mistakes.
- The insights must follow the "XXX, because XXX" format. They must not mention specific items but instead extract general principles applicable to similar work. They must be enlightening and provide guidance for future problems.

## Collaboration slice 1 (success):
### ${input.successCase.title}
Key steps: ${input.successCase.keySteps}

## Collaboration slice 2 (failure):
### Failed reason
${input.failureCase.reason}

### ${input.failureCase.title}
Key steps: ${input.failureCase.keySteps}

## Here are the EXISTING RULES (numbered — reference them by index):
${numberedRules(input.existingRules)}

By examining and contrasting the successful slice, and the list of existing rules, choose operations so the new list of rules is a set of GENERAL and HIGH LEVEL critiques of the failed slice, usable to avoid similar failures on different future work.

Respond with JSON only, in this shape:
{"operations": [{"op": "ADD", "statement": "..."} | {"op": "AGREE", "index": 1} | {"op": "EDIT", "index": 2, "statement": "..."} | {"op": "REMOVE", "index": 3}]}
Do at most 4 operations, and each existing rule can get at most 1 operation. Any existing rule not edited, not agreed, nor removed is considered copied.`,
    },
  ];
}

export function buildMergeRulesMessages(input: {
  rules: string[];
  limit: number;
}): DistillationMessages {
  return [
    {
      role: "system",
      content: `You are an agent skilled at summarizing and distilling insights. You are given a list of insights that were previously extracted from similar work. These insights may contain redundancy or overlap.

Your job is to **merge and consolidate similar insights**, and output a refined version that is **clear, actionable, and concise**.

NOTE:
- All merged insights **must be based strictly on the given inputs**. You are **not allowed to make up** or infer any new information.
- The output should be easy to read and follow.

Respond with JSON only, in this shape:
{"merged": ["Insight 1", "Insight 2"]}`,
    },
    {
      role: "user",
      content: `## Here are the current insights that need to be merged:
${numberedRules(input.rules)}

## Please consolidate and rewrite them into **no more than ${input.limit} refined insights**.

As the summarizing agent, remove redundancies, combine similar ideas, and ensure clarity.`,
    },
  ];
}

function critiqueSystemPrompt(rulesFull: boolean): string {
  const base = `You are an advanced reasoning agent that can add, edit, remove, or agree on rules in an existing rule set, based on forming new critiques of the team's completed work. The available operations are:

- AGREE (an existing rule is strongly relevant to the work at hand),
- REMOVE (an existing rule is contradictory or duplicates another),
- EDIT (an existing rule is not general enough or can be enhanced — rewrite and improve it),
- ADD (a new rule that is very different from existing rules and relevant to future work).

Do not mention the trials in the rules because all rules must be GENERALLY APPLICABLE. Each rule must be concise and easy to follow.`;
  return rulesFull
    ? `${base}

Focus on REMOVE or EDIT or AGREE rules first, and stop ADD rule unless the new rule is VERY insightful and different from EXISTING RULES.`
    : base;
}

function numberedRules(rules: string[]): string {
  if (rules.length === 0) return "1. (none yet)";
  return rules.map((rule, index) => `${index + 1}. ${rule}`).join("\n");
}
