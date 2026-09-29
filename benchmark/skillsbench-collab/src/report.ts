import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeDiagnostic } from "../../public-channel-memory/src/sanitize";
import type { ArmSummary, EvalAttempt } from "./types";

export function summarizeArm(
  arm: ArmSummary["arm"],
  attempts: EvalAttempt[],
): ArmSummary {
  const executed = attempts.filter((row) => row.taskMessageCount > 0).length;
  const passed = attempts.filter((row) => row.verification.passed).length;
  const scoreSum = attempts.reduce((sum, row) => sum + (row.verification.testScore ?? 0), 0);
  return {
    arm,
    tasks: attempts.map((row) => row.taskName),
    executed,
    passed,
    passRate: attempts.length > 0 ? Number((passed / attempts.length).toFixed(2)) : 0,
    scoreSum: Number(scoreSum.toFixed(2)),
    leaks: attempts.filter((row) => row.mechanism === "leak").length,
    mechanismFails: attempts.filter((row) => row.mechanism !== "ok" && row.mechanism !== "leak").length,
  };
}

export async function writeResults(input: {
  resultDir: string;
  attempts: EvalAttempt[];
  summaries: ArmSummary[];
}): Promise<{ jsonl: string; summary: string; csv: string }> {
  await mkdir(input.resultDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const jsonl = join(input.resultDir, `attempts-${stamp}.jsonl`);
  const summary = join(input.resultDir, `summary-${stamp}.txt`);
  const csv = join(input.resultDir, `result-${stamp}.csv`);
  await Bun.write(jsonl, input.attempts.map((row) => JSON.stringify(row)).join("\n") + (input.attempts.length ? "\n" : ""));
  const lines: string[] = [];
  for (const row of input.summaries) {
    lines.push(
      sanitizeDiagnostic(
        `${row.arm} tasks=${row.tasks.length} executed=${row.executed} passed=${row.passed} pass_rate=${row.passRate} score=${row.scoreSum} leak=${row.leaks} mechanism_fail=${row.mechanismFails}`,
      ),
    );
  }
  await Bun.write(summary, `${lines.join("\n")}\n`);
  const header = "taskname,executed,verified,passed,test_score,mechanism,citations,cost_time_s";
  const rows = input.attempts.map((row) =>
    [
      row.taskName,
      row.taskMessageCount > 0,
      row.verification.verified,
      row.verification.passed,
      row.verification.testScore ?? "",
      row.mechanism,
      row.citationCount,
      (row.elapsedMs / 1000).toFixed(1),
    ].join(","),
  );
  await Bun.write(csv, `${[header, ...rows].join("\n")}\n`);
  return { jsonl, summary, csv };
}
