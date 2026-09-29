/**
 * SkillFlow (arXiv 2604.17308, github ZhangZi-a/SkillFlow,
 * HF zhang-ziao/SkillFlow-Task, Harbor task format) → evolbench-collab
 * manifest adapter.
 *
 * Official protocol: 20 workflow families × 8–9 tasks each, a fixed
 * within-family difficulty order (ALL_TASK_DIFFICULTY_RANKING.json), an empty
 * skill library that evolves only within a family (resets between families),
 * and verifier-based scoring. The group-chat mapping is a direct fit: one
 * workspace per family (channel + agents persist across its tasks), skills
 * live only in OpenViking via the per-episode drain, the Memory Agent's offer
 * is the recall/reuse act, and cold/fresh-family arms are the empty-library
 * baseline. Execution environments are Harbor containers — see README for the
 * sidecar wiring; the manifest prompt stays environment-agnostic.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type SkillFlowManifestEpisode = {
  benchmark: string;
  episode_id: string;
  task_id: string;
  family_id: string;
  domain: string;
  split: "test";
  role: "qa";
  order: number;
  turns: [{ prompt: string }];
  grader: { kind: string; task_dir: string };
  upstream: { repo: string; family: string; rank: number };
};

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}
async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

/** The family ranking file lists task names easiest→hardest (rank 1..N). */
async function familyOrder(familyDir: string): Promise<string[]> {
  const rankingPath = join(familyDir, "ALL_TASK_DIFFICULTY_RANKING.json");
  if (await isFile(rankingPath)) {
    const parsed = JSON.parse(await readFile(rankingPath, "utf8")) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { ranking?: unknown[] }).ranking)
        ? (parsed as { ranking: unknown[] }).ranking
        : null;
    if (!list) throw new Error(`unrecognized ranking format in ${rankingPath}`);
    return list.map((name) => String(name));
  }
  // Without a ranking file, fall back to lexical task order.
  return (await readdir(familyDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function convertSkillFlowTasks(input: {
  tasksRoot: string;
  families?: readonly string[];
}): Promise<SkillFlowManifestEpisode[]> {
  const familiesWanted = input.families && input.families.length > 0 ? new Set(input.families) : null;
  const familyNames = (await readdir(input.tasksRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const episodes: SkillFlowManifestEpisode[] = [];
  for (const family of familyNames) {
    if (familiesWanted && !familiesWanted.has(family)) continue;
    const familyDir = join(input.tasksRoot, family);
    const order = await familyOrder(familyDir);
    for (const [index, taskName] of order.entries()) {
      const taskDir = join(familyDir, taskName);
      if (!(await isDir(taskDir))) continue;
      const instructionFile =
        (await isFile(join(taskDir, "instruction.md"))) ? join(taskDir, "instruction.md")
        : (await isFile(join(taskDir, "task.md"))) ? join(taskDir, "task.md")
        : null;
      if (!instructionFile) throw new Error(`${family}/${taskName} has no instruction.md`);
      const prompt = (await readFile(instructionFile, "utf8")).trim();
      if (!prompt) throw new Error(`${family}/${taskName} has an empty instruction`);
      episodes.push({
        benchmark: "skillflow",
        episode_id: `sf-${family}-${taskName}`,
        // family-qualified so the env sidecar can resolve the nested path
      task_id: `${family}/${taskName}`,
        family_id: `sf_${family}`,
        domain: family,
        split: "test",
        role: "qa",
        order: index + 1,
        turns: [{ prompt }],
        grader: { kind: "skillflow_harbor_verifier", task_dir: taskDir },
        upstream: { repo: "ZhangZi-a/SkillFlow", family, rank: index + 1 },
      });
    }
  }
  if (episodes.length === 0) throw new Error(`no SkillFlow tasks found under ${input.tasksRoot}`);
  return episodes;
}
