/**
 * Emits evolbench-collab manifests from the LifelongAgentBench / SkillFlow
 * upstream data. Output rows match the runner's manifest schema; expected
 * answers and grader references ride the grader block and never enter the
 * channel prompt.
 *
 * Usage:
 *   bun adapters/emit.ts lifelongagentbench --entries <entry_dict.json|hf.jsonl> \
 *       --task-type db_bench --output data/llmab-db.jsonl [--limit 50]
 *   bun adapters/emit.ts skillflow --tasks-root <SkillFlow-Task dir> \
 *       --output data/skillflow.jsonl [--families fam1,fam2]
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { convertLlabEntries, loadLlabEntries, type LlabTaskType } from "./lifelongagentbench";
import { convertSkillFlowTasks } from "./skillflow";

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}

function requireArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

const mode = process.argv[2];
if (mode !== "lifelongagentbench" && mode !== "skillflow") {
  console.error("usage: emit.ts lifelongagentbench|skillflow ...");
  process.exit(1);
}
const output = requireArg("output");
const rows =
  mode === "lifelongagentbench"
    ? convertLlabEntries({
        taskType: requireArg("task-type") as LlabTaskType,
        entries: await loadLlabEntries(requireArg("entries")),
        ...(arg("limit") ? { limit: Number(arg("limit")) } : {}),
      })
    : await convertSkillFlowTasks({
        tasksRoot: requireArg("tasks-root"),
        ...(arg("families")
          ? { families: arg("families")!.split(",").map((part) => part.trim()) }
          : {}),
      });
await mkdir(dirname(output), { recursive: true });
await Bun.write(output, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
console.log(`wrote ${rows.length} episodes -> ${output}`);
