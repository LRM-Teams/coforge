import { DEFAULT_LOCOMO_PATH } from "./locomo";
import { EVAL_ARMS, type EvalArm } from "./types";

/** Same pin as Pi `~/.pi/agent/models.json` and ADR 0053 memory-explorer smoke. */
export const PI_DEEPSEEK_V4_FLASH_PROVIDER = "lenovo-deepseek-v4-flash";
export const PI_DEEPSEEK_V4_FLASH_MODEL = "DeepSeek";

export type EvalEnv = {
  locomoPath: string;
  sampleId: string;
  qaLimit: number;
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
  pollMs: number;
  pollTimeoutMs: number;
  resultDir: string;
};

const FLAG = "COFORGE_PUBLIC_CHANNEL_MEMORY_EVAL";

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
  const judgeModel = env.COFORGE_EVAL_JUDGE_MODEL ?? "grok-4.6";
  const memoryAgentProvider = env.COFORGE_EVAL_MEMORY_AGENT_PROVIDER ?? PI_DEEPSEEK_V4_FLASH_PROVIDER;
  const memoryAgentModel = env.COFORGE_EVAL_MEMORY_AGENT_MODEL ?? PI_DEEPSEEK_V4_FLASH_MODEL;
  if (memoryAgentModel === judgeModel) {
    throw new Error("judge model must differ from Memory Agent model");
  }
  return {
    locomoPath: env.LOCOMO_DATA ?? DEFAULT_LOCOMO_PATH,
    sampleId: env.COFORGE_EVAL_SAMPLE_ID ?? "conv-26",
    qaLimit: Number(env.COFORGE_EVAL_QA_LIMIT ?? "6"),
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
    pollMs: Number(env.COFORGE_EVAL_POLL_MS ?? "2000"),
    pollTimeoutMs: Number(env.COFORGE_EVAL_POLL_TIMEOUT_MS ?? "180000"),
    resultDir: env.COFORGE_EVAL_RESULT_DIR ?? new URL("../result", import.meta.url).pathname,
  };
}

export const EVAL_FLAG = FLAG;
