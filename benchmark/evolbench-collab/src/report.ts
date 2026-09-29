import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeDiagnostic } from "../../public-channel-memory/src/sanitize";
import type { ArmSummary, AttemptRow } from "./types";

export function summarizeArm(
  arm: ArmSummary["arm"],
  rows: readonly AttemptRow[],
): ArmSummary {
  const benchmarks = new Set(rows.map((row) => row.benchmark));
  return {
    arm,
    benchmark: [...benchmarks].join("+") || "none",
    families: new Set(rows.map((row) => row.family_id)).size,
    episodes: rows.length,
    succeeded: rows.filter((row) => row.status === "success").length,
    offeredRecall: rows.filter((row) => row.recall_state !== "empty").length,
    leaks: rows.filter((row) => row.mechanism === "leak").length,
    mechanismFails: rows.filter((row) => row.mechanism !== "ok" && row.mechanism !== "leak").length,
  };
}

export type AttemptWriter = {
  path: string;
  append: (row: AttemptRow) => Promise<void>;
};

/** Incremental attempts.jsonl — the graders read this file after the run, so
 * every episode is flushed the moment it lands (crash-safe for long runs).
 * With resume=true an existing file is kept and its run_ids returned so the
 * runner can skip episodes that already landed. */
export async function createAttemptWriter(
  resultDir: string,
  evaluationId: string,
  resume = false,
): Promise<AttemptWriter & { completedRunIds: Set<string> }> {
  await mkdir(resultDir, { recursive: true });
  const path = join(resultDir, `${evaluationId}-attempts.jsonl`);
  const completedRunIds = new Set<string>();
  if (resume && (await Bun.file(path).exists())) {
    const seedContent = await Bun.file(path).text();
    for (const line of seedContent.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { run_id?: unknown };
        if (typeof row.run_id === "string") completedRunIds.add(row.run_id);
      } catch {
        // torn tail line from a crash; the rewrite below drops it
      }
    }
  } else {
    await Bun.write(path, "");
  }
  return {
    path,
    completedRunIds,
    async append(row) {
      // O_APPEND appends are line-atomic on Linux, so shard processes sharing
      // one evaluation id can write concurrently without tearing each other.
      await appendFile(path, `${JSON.stringify(row)}\n`);
    },
  };
}

export async function writeSummary(input: {
  resultDir: string;
  evaluationId: string;
  summaries: ArmSummary[];
}): Promise<string> {
  const path = join(input.resultDir, `${input.evaluationId}-summary.txt`);
  const lines = input.summaries.map((row) =>
    sanitizeDiagnostic(
      `${row.arm} benchmark=${row.benchmark} families=${row.families} episodes=${row.episodes} succeeded=${row.succeeded} recall_offered=${row.offeredRecall} leak=${row.leaks} mechanism_fail=${row.mechanismFails}`,
    ),
  );
  await Bun.write(path, `${lines.join("\n")}\n`);
  return path;
}
