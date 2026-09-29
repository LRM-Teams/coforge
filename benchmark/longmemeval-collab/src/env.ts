import { DEFAULT_LONGMEMEVAL_PATH } from "./longmemeval";
import { EVAL_ARMS, type EvalArm } from "./types";

/** Same pin as Pi `~/.pi/agent/models.json` and the public-channel eval. */
export const PI_DEEPSEEK_V4_FLASH_PROVIDER = "lenovo-deepseek-v4-flash";
export const PI_DEEPSEEK_V4_FLASH_MODEL = "DeepSeek";

export type EvalEnv = {
  dataPath: string;
  dataPin: string | null;
  sampleIndexes: number[];
  arms: EvalArm[];
  databaseUrl: string;
  redisUrl: string;
  ovUrl: string;
  ovConfPath: string;
  webUrl: string | null;
  cursorApiKey: string;
  cursorCli: string;
  judgeModel: string;
  memoryAgentProvider: string;
  memoryAgentModel: string;
  taskAgentProvider: string;
  taskAgentModel: string;
  pollMs: number;
  pollTimeoutMs: number;
  /** Quiet period after the Task Agent's last message before its reply is taken as final. */
  settleMs: number;
  ingestFromSession: number;
  resultDir: string;
};

const FLAG = "COFORGE_LME_COLLAB_EVAL";

export function evalOptedIn(env: Record<string, string | undefined> = Bun.env): boolean {
  return env[FLAG] === "1" || env[FLAG] === "true";
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing ${key}`);
  return value;
}

function parseIndexes(env: Record<string, string | undefined>): number[] {
  const list = env.COFORGE_EVAL_SAMPLES?.split(",").map((part) => Number(part.trim())).filter(Number.isInteger);
  if (list && list.length > 0) return list;
  const index = Number(env.COFORGE_EVAL_SAMPLE_INDEX ?? "0");
  const count = Math.max(1, Number(env.COFORGE_EVAL_SAMPLE_COUNT ?? "1"));
  if (!Number.isInteger(index) || index < 0) throw new Error("COFORGE_EVAL_SAMPLE_INDEX must be a non-negative integer");
  return Array.from({ length: count }, (_, offset) => index + offset);
}

export function loadEvalEnv(env: Record<string, string | undefined> = Bun.env): EvalEnv {
  const arms = (env.COFORGE_EVAL_ARMS ?? EVAL_ARMS.join(","))
    .split(",")
    .map((arm) => arm.trim())
    .filter((arm): arm is EvalArm => (EVAL_ARMS as readonly string[]).includes(arm));
  if (arms.length === 0) throw new Error("COFORGE_EVAL_ARMS has no recognized arm");
  const judgeModel = env.COFORGE_EVAL_JUDGE_MODEL ?? "grok-4.6";
  const memoryAgentProvider = env.COFORGE_EVAL_MEMORY_AGENT_PROVIDER ?? PI_DEEPSEEK_V4_FLASH_PROVIDER;
  const memoryAgentModel = env.COFORGE_EVAL_MEMORY_AGENT_MODEL ?? PI_DEEPSEEK_V4_FLASH_MODEL;
  const taskAgentProvider = env.COFORGE_EVAL_TASK_AGENT_PROVIDER ?? memoryAgentProvider;
  const taskAgentModel = env.COFORGE_EVAL_TASK_AGENT_MODEL ?? memoryAgentModel;
  if (memoryAgentModel === judgeModel || taskAgentModel === judgeModel) {
    throw new Error("judge model must differ from both agents' models");
  }
  return {
    dataPath: env.LONGMEMEVAL_DATA ?? DEFAULT_LONGMEMEVAL_PATH,
    dataPin: env.COFORGE_EVAL_DATA_PIN?.trim() || null,
    sampleIndexes: parseIndexes(env),
    arms,
    databaseUrl: required(env, "DATABASE_URL"),
    redisUrl: required(env, "REDIS_URL"),
    ovUrl: env.COFORGE_OPENVIKING_URL ?? "http://127.0.0.1:1933",
    ovConfPath:
      env.OPENVIKING_PROTOTYPE_CONF ??
      new URL("../../../infra/secrets/openviking_prototype_ov_conf", import.meta.url).pathname,
    webUrl: env.COFORGE_WEB_URL ?? null,
    cursorApiKey: required(env, "CURSOR_API_KEY"),
    cursorCli: env.CURSOR_CLI ?? "agent",
    judgeModel,
    memoryAgentProvider,
    memoryAgentModel,
    taskAgentProvider,
    taskAgentModel,
    pollMs: Number(env.COFORGE_EVAL_POLL_MS ?? "2000"),
    pollTimeoutMs: Number(env.COFORGE_EVAL_POLL_TIMEOUT_MS ?? "300000"),
    settleMs: Number(env.COFORGE_EVAL_SETTLE_MS ?? "15000"),
    ingestFromSession: Math.max(1, Number(env.COFORGE_EVAL_INGEST_FROM_SESSION ?? "1")),
    resultDir: env.COFORGE_EVAL_RESULT_DIR ?? new URL("../result", import.meta.url).pathname,
  };
}

export const EVAL_FLAG = FLAG;
