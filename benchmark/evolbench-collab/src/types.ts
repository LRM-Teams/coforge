/** One line of an evol_bench manifest (EvoAgentBench / AgentStream /
 * SkillLearnBench / PAST-Bench / EarthBench share this converted schema). */
export type ManifestEpisode = {
  benchmark: string;
  episodeId: string;
  taskId: string;
  familyId: string;
  domain: string;
  split: "train" | "test";
  role: string;
  order: number;
  prompt: string;
  grader: { kind: string } & Record<string, unknown>;
  stageFiles: { src: string; dst: string }[];
};

export type EpisodeFamily = {
  familyId: string;
  benchmark: string;
  episodes: ManifestEpisode[];
};

export const EVAL_ARMS = ["warm", "cold"] as const;
export type EvalArm = (typeof EVAL_ARMS)[number];

export type EpisodeStatus = "success" | "failure";

/** Row schema aligned with the evol_bench python graders: they join on
 * episode/task ids and read `final_output`; everything else is additive. */
export type AttemptRow = {
  run_id: string;
  benchmark: string;
  task_id: string;
  episode_id: string;
  family_id: string;
  domain: string;
  arm: EvalArm;
  memory_policy: "read_write" | "no_shared_memory";
  seed: number;
  attempt: number;
  status: EpisodeStatus;
  duration_seconds: number;
  work_dir: string;
  final_output: string;
  recall_state: "empty" | "offered" | "cited";
  recall_citations: number;
  mechanism: string;
  task_message_count: number;
  memory_leak_count: number;
  error: string | null;
  /** Set when the benchmark's env sidecar verified this episode (e.g.
   * SkillLearnBench official in-container verifier). */
  sidecar_verification?: {
    episode_id: string;
    reward: number;
    graded: boolean;
    error?: string | null;
  };
};

export type ArmSummary = {
  arm: EvalArm;
  benchmark: string;
  families: number;
  episodes: number;
  succeeded: number;
  offeredRecall: number;
  leaks: number;
  mechanismFails: number;
};
