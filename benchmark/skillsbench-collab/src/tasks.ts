import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SkillsBenchTask, TaskFile, TaskSkill } from "./types";

/** The ten tasks the OpenViking skillsbench evaluator excludes. */
export const EXCLUDED_TASKS = new Set([
  "gh-repo-analytics",
  "mhc-layer-impl",
  "pedestrian-traffic-counting",
  "pg-essay-to-audiobook",
  "scheduling-email-assistant",
  "speaker-diarization-subtitles",
  "multilingual-video-dubbing",
  "trend-anomaly-causal-inference",
  "video-filler-word-remover",
  "video-tutorial-indexer",
]);

export const DEFAULT_TASKS_DIR = new URL("../bench_data/tasks", import.meta.url).pathname;

/**
 * Current skillsbench tasks carry `task.md` (YAML frontmatter + instruction
 * body); the older revision the OV evaluator was written against used a bare
 * `instruction.md`. Support both.
 */
export function instructionFromBody(text: string): string {
  if (!text.startsWith("---")) return text.trim();
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (index === 0) continue;
    if (line.trim() === "---") return lines.slice(index + 1).join("\n").trim();
  }
  return text.trim();
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

async function listFilesRecursive(root: string, prefix = ""): Promise<TaskFile[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: TaskFile[] = [];
  for (const entry of entries) {
    if (entry.name === "__pycache__" || entry.name === ".DS_Store") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(join(root, entry.name), rel)));
    } else if (entry.isFile()) {
      files.push({ relPath: rel, absPath: join(root, entry.name) });
    }
  }
  return files.sort((left, right) => left.relPath.localeCompare(right.relPath));
}

export async function listTasks(tasksDir: string): Promise<string[]> {
  const entries = await readdir(tasksDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !EXCLUDED_TASKS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function loadTask(tasksDir: string, name: string): Promise<SkillsBenchTask> {
  const dir = join(tasksDir, name);
  if (!(await isDir(dir))) throw new Error(`task ${name} not found under ${tasksDir}`);
  let instructionPath = join(dir, "instruction.md");
  if (!(await isFile(instructionPath))) instructionPath = join(dir, "task.md");
  if (!(await isFile(instructionPath))) {
    throw new Error(`task ${name} has no instruction.md or task.md`);
  }
  const instruction = instructionFromBody(await readFile(instructionPath, "utf8"));

  const skillsDir = join(dir, "environment", "skills");
  const skills: TaskSkill[] = [];
  if (await isDir(skillsDir)) {
    for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = await listFilesRecursive(join(skillsDir, entry.name));
      if (files.length > 0) skills.push({ name: entry.name, files });
    }
  }

  const envDir = join(dir, "environment");
  const envFiles: TaskFile[] = [];
  if (await isDir(envDir)) {
    for (const entry of await readdir(envDir, { withFileTypes: true })) {
      if (entry.name === "skills" || entry.name === "Dockerfile" || entry.name === ".DS_Store")
        continue;
      const rel = entry.name;
      if (entry.isDirectory()) {
        envFiles.push(...(await listFilesRecursive(join(envDir, entry.name), rel)));
      } else if (entry.isFile()) {
        envFiles.push({ relPath: rel, absPath: join(envDir, entry.name) });
      }
    }
  }

  // Current upstream keeps the pytest verifier under verifier/; the older
  // revision the OV evaluator targeted used tests/.
  let testFiles = await listFilesRecursive(join(dir, "tests"));
  if (testFiles.length === 0) testFiles = await listFilesRecursive(join(dir, "verifier"));
  return { name, dir, instruction, skills, envFiles, testFiles };
}
