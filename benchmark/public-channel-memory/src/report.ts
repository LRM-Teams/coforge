import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeDiagnostic } from "./sanitize";
import type { ArmSummary, EvalAttempt } from "./types";

export function summarizeArm(arm: ArmSummary["arm"], workspaceId: string, sampleId: string, ingestedSessions: number, attempts: EvalAttempt[]): ArmSummary {
  const headline = attempts.filter((row) => row.headlineEligible);
  return {
    arm,
    sampleId,
    workspaceId,
    ingestedSessions,
    attempts: attempts.length,
    headlineCorrect: headline.filter((row) => row.judge === "CORRECT").length,
    headlineTotal: headline.length,
    leaks: attempts.filter((row) => row.mechanism === "leak").length,
    mechanismFails: attempts.filter((row) => row.mechanism !== "ok" && row.mechanism !== "leak").length,
  };
}

export async function writeResults(input: {
  resultDir: string;
  attempts: EvalAttempt[];
  summaries: ArmSummary[];
}): Promise<{ jsonl: string; summary: string }> {
  await mkdir(input.resultDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const jsonl = join(input.resultDir, `attempts-${stamp}.jsonl`);
  const summary = join(input.resultDir, `summary-${stamp}.txt`);
  await Bun.write(jsonl, input.attempts.map((row) => JSON.stringify(row)).join("\n") + (input.attempts.length ? "\n" : ""));
  const lines = input.summaries.map((row) =>
    sanitizeDiagnostic(
      `${row.arm} sample=${row.sampleId} sessions=${row.ingestedSessions} headline=${row.headlineCorrect}/${row.headlineTotal} leak=${row.leaks} mechanism_fail=${row.mechanismFails}`,
    ),
  );
  await Bun.write(summary, `${lines.join("\n")}\n`);
  return { jsonl, summary };
}
