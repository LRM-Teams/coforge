import { expect, test } from "bun:test";
import { EVAL_FLAG, evalOptedIn, loadEvalEnv } from "../src/env";

test("opt-in is fail-closed unless the explicit flag is 1 or true", () => {
  expect(evalOptedIn({})).toBe(false);
  expect(evalOptedIn({ [EVAL_FLAG]: "0" })).toBe(false);
  expect(evalOptedIn({ [EVAL_FLAG]: "1" })).toBe(true);
});

test("judge and Memory Agent models must differ", () => {
  const base = {
    DATABASE_URL: "postgres://local/coforge",
    REDIS_URL: "redis://127.0.0.1:6379",
    COFORGE_EVAL_JUDGE_BASE_URL: "https://judge.example",
    COFORGE_EVAL_JUDGE_API_KEY: "dummy",
    COFORGE_EVAL_JUDGE_MODEL: "judge-a",
    COFORGE_EVAL_MEMORY_AGENT_MODEL: "judge-a",
  };
  expect(() => loadEvalEnv(base)).toThrow("judge model must differ");
  expect(loadEvalEnv({ ...base, COFORGE_EVAL_MEMORY_AGENT_MODEL: "agent-b" }).judgeModel).toBe(
    "judge-a",
  );
});
