import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeDiagnostic } from "../../public-channel-memory/src/sanitize";
import type { ArmSummary, EvalAttempt, QuestionTypeSummary } from "./types";

export function summarizeArm(
  arm: ArmSummary["arm"],
  workspaceId: string,
  sampleId: string,
  ingestedSessions: number,
  attempts: EvalAttempt[],
): ArmSummary {
  const headline = attempts.filter((row) => row.headlineEligible);
  const byType = new Map<string, QuestionTypeSummary>();
  for (const attempt of attempts) {
    const key = attempt.questionType || "<missing>";
    const bucket = byType.get(key) ?? {
      questionType: key,
      attempts: 0,
      headlineTotal: 0,
      headlineCorrect: 0,
    };
    bucket.attempts += 1;
    if (attempt.headlineEligible) {
      bucket.headlineTotal += 1;
      if (attempt.judge === "CORRECT") bucket.headlineCorrect += 1;
    }
    byType.set(key, bucket);
  }
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
    byQuestionType: [...byType.values()].sort((left, right) => left.questionType.localeCompare(right.questionType)),
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
  const lines: string[] = [];
  for (const row of input.summaries) {
    lines.push(
      sanitizeDiagnostic(
        `${row.arm} sample=${row.sampleId} sessions=${row.ingestedSessions} headline=${row.headlineCorrect}/${row.headlineTotal} leak=${row.leaks} mechanism_fail=${row.mechanismFails}`,
      ),
    );
    for (const type of row.byQuestionType) {
      lines.push(
        sanitizeDiagnostic(
          `  ${type.questionType}: headline=${type.headlineCorrect}/${type.headlineTotal} attempts=${type.attempts}`,
        ),
      );
    }
  }
  await Bun.write(summary, `${lines.join("\n")}\n`);
  return { jsonl, summary };
}
