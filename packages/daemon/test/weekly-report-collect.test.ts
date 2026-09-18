import { expect, test } from "bun:test";
import { validateWeeklyReportCollectCommand } from "../src/connection/weekly-report-collect";

test("validateWeeklyReportCollectCommand accepts ready packs and rejects missing markdown", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  expect(
    validateWeeklyReportCollectCommand({
      requestId,
      runId,
      outcome: "ready",
      packMarkdown: "# hi",
    }),
  ).toEqual({ requestId, runId, outcome: "ready", packMarkdown: "# hi" });
  expect(
    validateWeeklyReportCollectCommand({
      requestId,
      runId,
      outcome: "ready",
    }),
  ).toBeNull();
  expect(
    validateWeeklyReportCollectCommand({
      requestId,
      runId,
      outcome: "empty",
    }),
  ).toEqual({ requestId, runId, outcome: "empty" });
  expect(
    validateWeeklyReportCollectCommand({
      requestId,
      runId,
      outcome: "failed",
      failureReason: "disk error",
    }),
  ).toEqual({ requestId, runId, outcome: "failed", failureReason: "disk error" });
});
