/** Per-benchmark prompt adaptation, mirroring the publish/format reminders the
 * evol_bench runners appended to every episode prompt. The coforge channel
 * equivalent: the final answer must arrive as the Task Agent's channel
 * message. */

export type BenchmarkProfile = {
  /** Appended to the episode prompt posted as the @memory question. */
  publishReminder: string;
  /** Default per-episode deadline before the reply is taken as-is. */
  episodeTimeoutMs: number;
  /** Quiet period after the Task Agent's last channel message. */
  settleMs: number;
};

const CODE_REMINDER = [
  "Channel note: your output reaches this room only through channel messages.",
  "Post your final answer as your last channel message, including the complete final code",
  "block in a fenced ```python``` (or required language) block. Intermediate work and test",
  "runs stay in your own workspace.",
].join(" ");

const CALL_LIST_REMINDER = [
  "Channel note: respond with the exact function call(s) in the required single-line",
  "Python-call list syntax as your final channel message.",
].join(" ");

const GENERIC_REMINDER = [
  "Channel note: post your final answer as your last channel message, in the exact format",
  "the task requests. Intermediate work stays in your own workspace.",
].join(" ");

const MCQ_REMINDER = [
  "Channel note: post your final answer as your last channel message in the official",
  "format: <Answer>X</Answer>.",
].join(" ");

const REGISTRY: Record<string, BenchmarkProfile> = {
  evoagentbench: { publishReminder: CODE_REMINDER, episodeTimeoutMs: 900_000, settleMs: 120_000 },
  agentstream: { publishReminder: CODE_REMINDER, episodeTimeoutMs: 900_000, settleMs: 120_000 },
  skilllearnbench: { publishReminder: GENERIC_REMINDER, episodeTimeoutMs: 900_000, settleMs: 180_000 },
  past_bench: { publishReminder: GENERIC_REMINDER, episodeTimeoutMs: 360_000, settleMs: 60_000 },
  earthbench: { publishReminder: MCQ_REMINDER, episodeTimeoutMs: 1_200_000, settleMs: 120_000 },
  // LifelongAgentBench: one fixed sequential stream per task type; answer
  // formats are "Final Answer: ..." (SQL tuples / final variables), so the
  // generic reminder fits; environments are external sidecars.
  lifelongagentbench: { publishReminder: GENERIC_REMINDER, episodeTimeoutMs: 900_000, settleMs: 120_000 },
  // SkillFlow: office/data workflow artifacts in the workspace; the verifier
  // inspects produced files, so the reminder must emphasize writing files.
  skillflow: { publishReminder: CODE_REMINDER, episodeTimeoutMs: 1_200_000, settleMs: 180_000 },
};

export function profileFor(benchmark: string): BenchmarkProfile {
  return REGISTRY[benchmark] ?? { publishReminder: GENERIC_REMINDER, episodeTimeoutMs: 900_000, settleMs: 120_000 };
}

/** AgentStream's function_calling domain wants the call-list contract rather
 * than the code-block one. */
export function reminderForEpisode(benchmark: string, domain: string): string {
  const profile = profileFor(benchmark);
  if (benchmark === "agentstream" && domain === "function_calling") return CALL_LIST_REMINDER;
  return profile.publishReminder;
}
