import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { episodesForArm, groupFamilies, loadManifest, parseManifestLine } from "../src/manifest";

const EVO_LINE = JSON.stringify({
  benchmark: "evoagentbench",
  episode_id: "1883_C",
  task_id: "1883_C",
  domain: "code_implementation",
  split: "train",
  turns: [{ prompt: "You are an expert Python programmer…" }],
  grader: { kind: "livecodebench.check_correctness", question_id: "1883_C" },
});

const STREAM_LINE = JSON.stringify({
  benchmark: "agentstream",
  episode_id: "code-3423",
  task_id: "3423",
  family_id: "stream",
  domain: "code",
  split: "test",
  order: 7,
  turns: [{ prompt: "Write a function…" }],
  grader: { kind: "livecodebench.check_correctness" },
});

const PAST_LINE = JSON.stringify({
  benchmark: "past_bench",
  episode_id: "learn_a",
  task_id: "SM01_LEARN_A_001",
  family_id: "SM01_preference_adoption",
  domain: "",
  split: "train",
  role: "learn",
  order: 1,
  turns: [{ prompt: "Notes fixture…" }],
  grader: { kind: "past_official_channel" },
});

describe("parseManifestLine", () => {
  test("keeps explicit family/order and defaults role from split", () => {
    const episode = parseManifestLine(STREAM_LINE, 0)!;
    expect(episode.familyId).toBe("stream");
    expect(episode.order).toBe(7);
    expect(episode.role).toBe("qa");
    expect(episode.grader.kind).toBe("livecodebench.check_correctness");
  });

  test("evo lines fall back to domain family and line order", () => {
    const episode = parseManifestLine(EVO_LINE, 4)!;
    expect(episode.familyId).toBe("code_implementation");
    expect(episode.order).toBe(5);
    expect(episode.role).toBe("ingestion");
  });

  test("keeps explicit roles like past learn episodes", () => {
    const episode = parseManifestLine(PAST_LINE, 0)!;
    expect(episode.role).toBe("learn");
  });

  test("empty lines are skipped; promptless lines are rejected", () => {
    expect(parseManifestLine("", 0)).toBeNull();
    expect(() => parseManifestLine(JSON.stringify({ benchmark: "x" }), 2)).toThrow("no turns[0].prompt");
  });
});

describe("groupFamilies + episodesForArm", () => {
  test("warm keeps everything in order; cold keeps only the test split", () => {
    const lines = [
      { ...JSON.parse(PAST_LINE), episode_id: "learn_a", order: 1, split: "train" },
      { ...JSON.parse(PAST_LINE), episode_id: "learn_b", order: 2, split: "train" },
      { ...JSON.parse(PAST_LINE), episode_id: "eval_near", order: 3, split: "test" },
      { ...JSON.parse(STREAM_LINE), episode_id: "code-1", order: 40 },
    ];
    const episodes = lines.map((line, index) => parseManifestLine(JSON.stringify(line), index)!);
    const families = groupFamilies(episodes);
    expect(families.map((family) => family.familyId).sort()).toEqual([
      "SM01_preference_adoption",
      "stream",
    ]);
    const past = families.find((family) => family.familyId === "SM01_preference_adoption")!;
    expect(past.episodes.map((episode) => episode.episodeId)).toEqual(["learn_a", "learn_b", "eval_near"]);
    expect(episodesForArm(past, "warm")).toHaveLength(3);
    expect(episodesForArm(past, "cold").map((episode) => episode.episodeId)).toEqual(["eval_near"]);
  });
});

describe("loadManifest", () => {
  test("loads a real-shaped jsonl file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evol-manifest-"));
    const path = join(dir, "manifest.jsonl");
    await Bun.write(path, [EVO_LINE, "", STREAM_LINE].join("\n") + "\n");
    const episodes = await loadManifest(path);
    expect(episodes).toHaveLength(2);
    expect(episodes[1]!.episodeId).toBe("code-3423");
  });

  test("rejects an empty manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evol-manifest-empty-"));
    const path = join(dir, "empty.jsonl");
    await Bun.write(path, "\n\n");
    await expect(loadManifest(path)).rejects.toThrow("no episodes");
  });
});
