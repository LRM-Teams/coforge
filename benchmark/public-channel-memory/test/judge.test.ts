import { expect, test } from "bun:test";
import { buildJudgePrompt, cursorJudgeArgv, parseJudgeResult, preprocessAnswer } from "../src/judge";

test("category 3 gold answers keep only the clause before a semicolon", () => {
  expect(preprocessAnswer(3, "Paris; also Lyon")).toBe("Paris");
  expect(preprocessAnswer(1, "Paris; also Lyon")).toBe("Paris; also Lyon");
});

test("parses LoCoMo judge JSON and rejects empty or unlabeled text", () => {
  expect(parseJudgeResult('{"label":"CORRECT","reasoning":"same fact"}')).toEqual({
    label: "CORRECT",
    reason: "same fact",
  });
  expect(parseJudgeResult("prefix {\"label\":\"WRONG\",\"reasoning\":\"no\"} suffix").label).toBe(
    "WRONG",
  );
  expect(parseJudgeResult("").label).toBe("UNJUDGED");
  expect(parseJudgeResult("not json").label).toBe("UNJUDGED");
});

test("judge prompt includes the gold and generated answers", () => {
  const prompt = buildJudgePrompt({
    category: 4,
    question: "Where does Caroline live?",
    goldAnswer: "Seattle",
    response: "She lives in Seattle",
  });
  expect(prompt).toContain("Where does Caroline live?");
  expect(prompt).toContain("Seattle");
  expect(prompt).toContain("She lives in Seattle");
});

test("Cursor CLI judge is non-interactive ask mode and never puts the key on argv", () => {
  const argv = cursorJudgeArgv({
    cli: "agent",
    model: "grok-4.6",
    workspace: "/tmp/pcm-judge",
    prompt: '{"label":"CORRECT"}',
  });
  expect(argv[0]).toBe("agent");
  expect(argv).toContain("-p");
  expect(argv).toContain("ask");
  expect(argv.join(" ")).not.toMatch(/api-key|CURSOR_API_KEY|cursor_/);
});
