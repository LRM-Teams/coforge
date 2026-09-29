import { DEFAULT_TASKS_DIR } from "./tasks";
import { EVAL_ARMS, type EvalArm } from "./types";

/** Same pin as Pi `~/.pi/agent/models.json` and the sibling evals. */
export const PI_DEEPSEEK_V4_FLASH_PROVIDER = "lenovo-deepseek-v4-flash";
export const PI_DEEPSEEK_V4_FLASH_MODEL = "DeepSeek";

export type EvalEnv = {
  tasksDir: string;
  taskNames: string[];
  arms: EvalArm[];
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
  /** Overall deadline for the collaboration + execution phase (the OV evaluator
   * gave vikingbot 2400s per task; two agent hops need more headroom). */
  pollTimeoutMs: number;
  /** Quiet period after the Task Agent's last channel message before the task
   * is considered done and pytest verification runs. */
  settleMs: number;
  resultDir: string;
};

const FLAG = "COFORGE_SKILLSBENCH_COLLAB_EVAL";

export function evalOptedIn(env: Record<string, string | undefined> = Bun.env): boolean {
  return env[FLAG] === "1" || env[FLAG] === "true";
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing ${key}`);
  return value;
}

export function loadEvalEnv(env: Record<string, string | undefined> = Bun.env): EvalEnv {
  const arms = (env.COFORGE_EVAL_ARMS ?? EVAL_ARMS.join(","))
    .split(",")
    .map((arm) => arm.trim())
    .filter((arm): arm is EvalArm => (EVAL_ARMS as readonly string[]).includes(arm));
  if (arms.length === 0) throw new Error("COFORGE_EVAL_ARMS has no recognized arm");
  const memoryAgentProvider = env.COFORGE_EVAL_MEMORY_AGENT_PROVIDER ?? PI_DEEPSEEK_V4_FLASH_PROVIDER;
  const memoryAgentModel = env.COFORGE_EVAL_MEMORY_AGENT_MODEL ?? PI_DEEPSEEK_V4_FLASH_MODEL;
  const taskAgentProvider = env.COFORGE_EVAL_TASK_AGENT_PROVIDER ?? memoryAgentProvider;
  const taskAgentModel = env.COFORGE_EVAL_TASK_AGENT_MODEL ?? memoryAgentModel;
  return {
    tasksDir: env.SKILLSBENCH_TASKS_DIR ?? DEFAULT_TASKS_DIR,
    taskNames: (env.COFORGE_EVAL_TASKS ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
    arms,
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
    pollTimeoutMs: Number(env.COFORGE_EVAL_POLL_TIMEOUT_MS ?? "2700000"),
    settleMs: Number(env.COFORGE_EVAL_SETTLE_MS ?? "180000"),
    resultDir: env.COFORGE_EVAL_RESULT_DIR ?? new URL("../result", import.meta.url).pathname,
  };
}

export const EVAL_FLAG = FLAG;
