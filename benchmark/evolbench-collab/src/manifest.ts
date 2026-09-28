import type { EpisodeFamily, EvalArm, ManifestEpisode } from "./types";

type RawEpisode = {
  benchmark?: unknown;
  episode_id?: unknown;
  task_id?: unknown;
  family_id?: unknown;
  domain?: unknown;
  split?: unknown;
  role?: unknown;
  order?: unknown;
  turns?: unknown;
  grader?: unknown;
  stage_files?: unknown;
};

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Loads one evol_bench manifest. Field gaps per benchmark are normalized:
 * EvoAgentBench lines carry no family_id/order (family = domain, order = file
 * line); roles default to split semantics.
 */
export function parseManifestLine(line: string, index: number): ManifestEpisode | null {
  if (!line.trim()) return null;
  const raw = JSON.parse(line) as RawEpisode;
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  const firstTurn = turns[0] as { prompt?: unknown } | undefined;
  const prompt = text(firstTurn?.prompt);
  if (!prompt) throw new Error(`manifest line ${index + 1} has no turns[0].prompt`);
  const split = raw.split === "train" ? "train" : "test";
  const grader =
    raw.grader && typeof raw.grader === "object"
      ? (raw.grader as { kind?: unknown } & Record<string, unknown>)
      : { kind: "none" };
  return {
    benchmark: text(raw.benchmark),
    episodeId: text(raw.episode_id),
    taskId: text(raw.task_id),
    familyId: text(raw.family_id, text(raw.domain, "default")),
    domain: text(raw.domain),
    split,
    role: text(raw.role, split === "train" ? "ingestion" : "qa"),
    order: numberOr(raw.order, index + 1),
    prompt,
    grader: { ...grader, kind: text(grader.kind, "none") },
    stageFiles: Array.isArray(raw.stage_files)
      ? (raw.stage_files as { src?: unknown; dst?: unknown }[]).map((file) => ({
          src: text(file.src),
          dst: text(file.dst),
        }))
      : [],
  };
}

export async function loadManifest(
  path: string,
  episodeMod?: string | null,
): Promise<ManifestEpisode[]> {
  const raw = await Bun.file(path).text();
  const episodes: ManifestEpisode[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    const episode = parseManifestLine(line, index);
    if (episode) episodes.push(episode);
  }
  if (episodes.length === 0) throw new Error(`manifest ${path} has no episodes`);
  if (episodeMod) {
    const match = episodeMod.match(/^(\d+):(\d+)$/);
    if (!match) throw new Error(`COFORGE_EVAL_EPISODE_MOD must be N:k, got ${episodeMod}`);
    const [n, k] = [Number(match[1]), Number(match[2])];
    if (n < 1 || k >= n) throw new Error(`COFORGE_EVAL_EPISODE_MOD must be N:k with k < N`);
    // Shard by manifest position, not family order, so shards interleave
    // evenly across families for order-independent arms.
    return episodes.filter((_, index) => index % n === k);
  }
  return episodes;
}

/** Families preserve manifest order; episodes sort by (order, episode id). */
export function groupFamilies(episodes: readonly ManifestEpisode[]): EpisodeFamily[] {
  const families = new Map<string, EpisodeFamily>();
  for (const episode of episodes) {
    const family = families.get(episode.familyId) ?? {
      familyId: episode.familyId,
      benchmark: episode.benchmark,
      episodes: [],
    };
    family.episodes.push(episode);
    families.set(episode.familyId, family);
  }
  for (const family of families.values()) {
    family.episodes.sort((left, right) =>
      left.order !== right.order
        ? left.order - right.order
        : left.episodeId.localeCompare(right.episodeId),
    );
  }
  return [...families.values()];
}

/**
 * Arm semantics (mirrors the evol_bench runners): warm executes every episode
 * of the family in order — train sedimentation included; cold executes only
 * the test split, each in a zero-state workspace.
 */
export function episodesForArm(
  family: EpisodeFamily,
  arm: EvalArm,
): ManifestEpisode[] {
  if (arm === "warm") return family.episodes;
  return family.episodes.filter((episode) => episode.split === "test");
}
