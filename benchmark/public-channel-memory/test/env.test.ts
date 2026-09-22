import { expect, test } from "bun:test";
import {
  EVAL_FLAG,
  PI_DEEPSEEK_V4_FLASH_MODEL,
  PI_DEEPSEEK_V4_FLASH_PROVIDER,
  evalOptedIn,
  loadEvalEnv,
} from "../src/env";

test("opt-in is fail-closed unless the explicit flag is 1 or true", () => {
  expect(evalOptedIn({})).toBe(false);
  expect(evalOptedIn({ [EVAL_FLAG]: "0" })).toBe(false);
  expect(evalOptedIn({ [EVAL_FLAG]: "1" })).toBe(true);
});

test("judge and Memory Agent models must differ", () => {
  const base = {
    DATABASE_URL: "postgres://local/coforge",
    REDIS_URL: "redis://127.0.0.1:6379",
    CURSOR_API_KEY: "cursor_test",
    COFORGE_EVAL_JUDGE_MODEL: "judge-a",
    COFORGE_EVAL_MEMORY_AGENT_MODEL: "judge-a",
  };
  expect(() => loadEvalEnv(base)).toThrow("judge model must differ");
  expect(loadEvalEnv({ ...base, COFORGE_EVAL_MEMORY_AGENT_MODEL: "agent-b" }).judgeModel).toBe(
    "judge-a",
  );
  const defaults = loadEvalEnv({
    DATABASE_URL: "postgres://local/coforge",
    REDIS_URL: "redis://127.0.0.1:6379",
    CURSOR_API_KEY: "cursor_test",
  });
  expect(defaults.judgeModel).toBe("grok-4.6");
  expect(defaults.memoryAgentProvider).toBe(PI_DEEPSEEK_V4_FLASH_PROVIDER);
  expect(defaults.memoryAgentModel).toBe(PI_DEEPSEEK_V4_FLASH_MODEL);
});
