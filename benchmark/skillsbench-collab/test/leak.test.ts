import { classifyMechanism } from "../src/leak";
import { summarizeArm } from "../src/report";
import type { EvalAttempt } from "../src/types";

describe("classifyMechanism", () => {
  const ok = {
    reply: "Done: result.json written.",
    offerMessageId: "offer-1",
    citationCount: 2,
    memoryLeakMessageIds: [],
  };

  test("cited offer plus task reply is headline eligible", () => {
    expect(classifyMechanism(ok)).toEqual({ mechanism: "ok", headlineEligible: true });
  });

  test("timeout with completed collaboration still counts; pytest judges", () => {
    expect(classifyMechanism({ ...ok, timedOut: true })).toEqual({
      mechanism: "timeout",
      headlineEligible: true,
    });
  });

  test("no offer means the skill never arrived through memory", () => {
    expect(classifyMechanism({ ...ok, offerMessageId: null }).mechanism).toBe("no_offer");
  });

  test("uncited offer cannot carry the skill", () => {
    expect(classifyMechanism({ ...ok, citationCount: 0 }).mechanism).toBe("uncited_offer");
  });

  test("memory agent channel answer beside the offer is a leak", () => {
    expect(classifyMechanism({ ...ok, memoryLeakMessageIds: ["m-1"] }).mechanism).toBe("leak");
  });

  test("missing task reply", () => {
    expect(classifyMechanism({ ...ok, reply: null }).mechanism).toBe("no_reply");
  });
});

function attempt(overrides: Partial<EvalAttempt>): EvalAttempt {
  return {
    arm: "openviking",
    taskName: "task-x",
    instructionExcerpt: "do x",
    reply: "done",
    offerMessageId: "offer-1",
    citationCount: 1,
    taskMessageCount: 2,
    memoryLeakMessageIds: [],
    toolsUsed: ["ov_find", "ov_read"],
    mechanism: "ok",
    headlineEligible: true,
    verification: { verified: true, passed: true, testScore: 1, output: "", error: null },
    elapsedMs: 1000,
    ...overrides,
  };
}

describe("summarizeArm", () => {
  test("aggregates pass rate and score like the OV summary", () => {
    const summary = summarizeArm("openviking", [
      attempt({ taskName: "a", verification: { verified: true, passed: true, testScore: 1, output: "", error: null } }),
      attempt({
        taskName: "b",
        verification: { verified: true, passed: false, testScore: 0.5, output: "", error: null },
      }),
      attempt({
        taskName: "c",
        taskMessageCount: 0,
        reply: null,
        mechanism: "no_offer",
        offerMessageId: null,
        verification: { verified: true, passed: false, testScore: null, output: "no pytest files, skipping verification", error: null },
      }),
    ]);
    expect(summary.tasks).toEqual(["a", "b", "c"]);
    expect(summary.executed).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.passRate).toBe(0.33);
    expect(summary.scoreSum).toBe(1.5);
    expect(summary.mechanismFails).toBe(1);
  });
});
