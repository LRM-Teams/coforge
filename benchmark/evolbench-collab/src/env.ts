import { EVAL_ARMS, type EvalArm } from "./types";

/** Same pin as Pi `~/.pi/agent/models.json` and the sibling evals. */
export const PI_DEEPSEEK_V4_FLASH_PROVIDER = "lenovo-deepseek-v4-flash";
export const PI_DEEPSEEK_V4_FLASH_MODEL = "DeepSeek";

export const DEFAULT_MANIFESTS: Record<string, string> = {
  evoagentbench: "/home/zhoujie22/river2_0/evol_bench/EvoAgentBench/data/evo-code-implementation.jsonl",
  agentstream: "/home/zhoujie22/river2_0/evol_bench/AgentStream/data/agentstream-interleaved-seed1.jsonl",
  skilllearnbench: "/home/zhoujie22/river2_0/evol_bench/SkillLearnBench/data/slb-full.jsonl",
  past_bench: "/home/zhoujie22/river2_0/evol_bench/PAST-Bench/data/past-notes-memory.jsonl",
  earthbench: "/home/zhoujie22/river2_0/evol_bench/EarthBench/data/eb-smoke.jsonl",
};

export type EvalEnv = {
  manifestPath: string;
  manifestBenchmark: string | null;
  families: string[];
  arms: EvalArm[];
  seed: number;
  evaluationId: string;
  databaseUrl: string;
  redisUrl: string;
  ovUrl: string;
  ovConfPath: string;
  webUrl: string | null;
  memoryAgentProvider: string;
  memoryAgentModel: string;
  taskAgentProvider: string;
  taskAgentModel: string;
  pollMs: number;
  episodeTimeoutMs: number | null;
  settleMs: number | null;
  /** Episode closure between warm episodes: reset-session both agents. */
  episodeClosure: boolean;
  /** Appended to every episode prompt after %TASK_ID%/%EPISODE_ID%/%%SIDECAR%%
   * substitution — used for env-sidecar wiring (SkillLearnBench, ...). */
  envNote: string | null;
  /** Env sidecar that can verify an episode (POST /verify {episode_id}). */
  verifySidecarUrl: string | null;
  /** Shard filter for order-independent episode streams: "N:k" keeps episodes
   * whose zero-based manifest index satisfies index % N === k. */
  episodeMod: string | null;
  /** Bail out early when nothing at all is happening (no offer AND no task
   * message for this many ms) instead of riding the full deadline. */
  abortQuietMs: number;
  resultDir: string;
};

const FLAG = "COFORGE_EVOLBENCH_COLLAB_EVAL";

export function evalOptedIn(env: Record<string, string | undefined> = Bun.env): boolean {
  return env[FLAG] === "1" || env[FLAG] === "true";
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing ${key}`);
  return value;
}

export function loadEvalEnv(env: Record<string, string | undefined> = Bun.env): EvalEnv {
  const arms = (env.COFORGE_EVAL_ARMS ?? "warm,cold")
    .split(",")
    .map((arm) => arm.trim())
    .filter((arm): arm is EvalArm => (EVAL_ARMS as readonly string[]).includes(arm));
  if (arms.length === 0) throw new Error("COFORGE_EVAL_ARMS has no recognized arm (warm|cold)");
  const manifestPath = required(env, "COFORGE_EVAL_MANIFEST");
  const memoryAgentProvider = env.COFORGE_EVAL_MEMORY_AGENT_PROVIDER ?? PI_DEEPSEEK_V4_FLASH_PROVIDER;
  const memoryAgentModel = env.COFORGE_EVAL_MEMORY_AGENT_MODEL ?? PI_DEEPSEEK_V4_FLASH_MODEL;
  const taskAgentProvider = env.COFORGE_EVAL_TASK_AGENT_PROVIDER ?? memoryAgentProvider;
  const taskAgentModel = env.COFORGE_EVAL_TASK_AGENT_MODEL ?? memoryAgentModel;
  return {
    manifestPath,
    manifestBenchmark: env.COFORGE_EVAL_MANIFEST_BENCHMARK?.trim() || null,
    families: (env.COFORGE_EVAL_FAMILIES ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
    arms,
    seed: Number(env.COFORGE_EVAL_SEED ?? "1"),
    evaluationId: env.COFORGE_EVALUATION_ID ?? `evol-collab-${new Date().toISOString().slice(0, 10)}`,
    databaseUrl: required(env, "DATABASE_URL"),
    redisUrl: required(env, "REDIS_URL"),
    ovUrl: env.COFORGE_OPENVIKING_URL ?? "http://127.0.0.1:1933",
    ovConfPath:
      env.OPENVIKING_PROTOTYPE_CONF ??
      new URL("../../../infra/secrets/openviking_prototype_ov_conf", import.meta.url).pathname,
    webUrl: env.COFORGE_WEB_URL ?? null,
    memoryAgentProvider,
    memoryAgentModel,
    taskAgentProvider,
    taskAgentModel,
    pollMs: Number(env.COFORGE_EVAL_POLL_MS ?? "5000"),
    episodeTimeoutMs: env.COFORGE_EVAL_EPISODE_TIMEOUT_MS
      ? Number(env.COFORGE_EVAL_EPISODE_TIMEOUT_MS)
      : null,
    settleMs: env.COFORGE_EVAL_SETTLE_MS ? Number(env.COFORGE_EVAL_SETTLE_MS) : null,
    episodeClosure: (env.COFORGE_EVAL_EPISODE_CLOSURE ?? "1") !== "0",
    envNote: env.COFORGE_EVAL_ENV_NOTE?.trim() || null,
    verifySidecarUrl: env.COFORGE_EVAL_VERIFY_SIDECAR?.trim() || null,
    episodeMod: env.COFORGE_EVAL_EPISODE_MOD?.trim() || null,
    abortQuietMs: Number(env.COFORGE_EVAL_ABORT_QUIET_MS ?? "600000"),
    resultDir: env.COFORGE_EVAL_RESULT_DIR ?? new URL("../result", import.meta.url).pathname,
  };
}

export const EVAL_FLAG = FLAG;
