import { profileFor, reminderForEpisode } from "../src/benchmarks";
import { classifyMechanism } from "../src/leak";
import { summarizeArm } from "../src/report";
import { episodePrompt } from "../src/eval-qa";
import type { AttemptRow } from "../src/types";
import type { EpisodeResult } from "../src/eval-qa";

describe("benchmark registry", () => {
  test("all five evol_bench manifests have profiles", () => {
    for (const benchmark of [
      "evoagentbench",
      "agentstream",
      "skilllearnbench",
      "past_bench",
      "earthbench",
    ]) {
      const profile = profileFor(benchmark);
      expect(profile.publishReminder.length).toBeGreaterThan(20);
      expect(profile.episodeTimeoutMs).toBeGreaterThan(0);
    }
  });

  test("agentstream function_calling uses the call-list contract", () => {
    expect(reminderForEpisode("agentstream", "function_calling")).toContain("Python-call list");
    expect(reminderForEpisode("agentstream", "code")).toContain("code");
    expect(reminderForEpisode("evoagentbench", "code_implementation")).toContain("fenced");
  });

  test("unknown benchmarks fall back to the generic reminder", () => {
    expect(profileFor("mystery").publishReminder).toContain("final answer");
  });
});

describe("episodePrompt", () => {
  test("addresses the memory agent and appends the reminder", () => {
    const prompt = episodePrompt(
      { benchmark: "past_bench", episodeId: "e", taskId: "t", familyId: "f", domain: "", split: "test", role: "qa", order: 1, prompt: "Summarize the notes.", grader: { kind: "x" }, stageFiles: [] },
      reminderForEpisode("past_bench", ""),
    );
    expect(prompt.startsWith("@memory Summarize the notes.")).toBe(true);
    expect(prompt).toContain("Channel note:");
  });
});

describe("classifyMechanism", () => {
  const base: EpisodeResult = {
    finalOutput: "```python\nprint(1)\n```",
    offerMessageId: "offer-1",
    citationCount: 2,
    taskMessageCount: 1,
    memoryLeakMessageIds: [],
    timedOut: false,
    elapsedMs: 1000,
  };

  test("cited offer plus posted answer is ok", () => {
    expect(classifyMechanism(base)).toBe("ok");
  });

  test("answer without recall is no_offer; leak dominates; timeout keeps the answer", () => {
    expect(classifyMechanism({ ...base, offerMessageId: null })).toBe("no_offer");
    expect(classifyMechanism({ ...base, memoryLeakMessageIds: ["m"] })).toBe("leak");
    expect(classifyMechanism({ ...base, citationCount: 0 })).toBe("uncited_offer");
    expect(classifyMechanism({ ...base, timedOut: true })).toBe("timeout");
    expect(classifyMechanism({ ...base, finalOutput: null })).toBe("no_reply");
  });
});

describe("summarizeArm", () => {
  test("aggregates arm rows", () => {
    const row: AttemptRow = {
      run_id: "r:e:1:warm",
      benchmark: "past_bench",
      task_id: "t",
      episode_id: "e",
      family_id: "f",
      domain: "",
      arm: "warm",
      memory_policy: "read_write",
      seed: 1,
      attempt: 1,
      status: "success",
      duration_seconds: 12.5,
      work_dir: "/tmp/w",
      final_output: "answer",
      recall_state: "cited",
      recall_citations: 2,
      mechanism: "ok",
      task_message_count: 1,
      memory_leak_count: 0,
      error: null,
    };
    const summary = summarizeArm("warm", [row, { ...row, episode_id: "e2", mechanism: "no_offer", recall_state: "empty" }]);
    expect(summary.episodes).toBe(2);
    expect(summary.families).toBe(1);
    expect(summary.offeredRecall).toBe(1);
    expect(summary.mechanismFails).toBe(1);
  });
});
