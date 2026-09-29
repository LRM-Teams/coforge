import { buildJudgePrompt, parseJudgeVerdict } from "../src/judge";

describe("parseJudgeVerdict", () => {
  test("accepts the prompt's contract: bare yes/no after the thinking block", () => {
    const yes = parseJudgeVerdict(
      "<judge_thinking>The response matches the gold answer.</judge_thinking>\n\nyes",
    );
    expect(yes.label).toBe("CORRECT");
    const no = parseJudgeVerdict(
      "<judge_thinking>Wrong number of trips.</judge_thinking>\n\nno",
    );
    expect(no.label).toBe("WRONG");
  });

  test("tolerates punctuation and case on the verdict line", () => {
    expect(parseJudgeVerdict("Yes.").label).toBe("CORRECT");
    expect(parseJudgeVerdict("NO.").label).toBe("WRONG");
  });

  test("accepts the repo judge's JSON is_correct form", () => {
    expect(parseJudgeVerdict('{"is_correct": "CORRECT"}').label).toBe("CORRECT");
    expect(parseJudgeVerdict('{"is_correct": "WRONG"}').label).toBe("WRONG");
  });

  test("missing verdict stays UNJUDGED", () => {
    expect(parseJudgeVerdict("<judge_thinking>hmm</judge_thinking>").label).toBe("UNJUDGED");
    expect(parseJudgeVerdict("").label).toBe("UNJUDGED");
    expect(parseJudgeVerdict("The answer seems right to me").label).toBe("UNJUDGED");
  });
});

describe("buildJudgePrompt", () => {
  test("interpolates question, gold answer, and response", () => {
    const prompt = buildJudgePrompt({
      question: "What degree did I graduate with?",
      goldAnswer: "Business Administration",
      response: "You graduated with a Business Administration degree.",
    });
    expect(prompt).toContain("Question: What degree did I graduate with?");
    expect(prompt).toContain("Correct Answer: Business Administration");
    expect(prompt).toContain(
      "Model Response: You graduated with a Business Administration degree.",
    );
    expect(prompt).toContain("<judge_thinking>");
  });
});
