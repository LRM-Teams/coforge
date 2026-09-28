import { expect, test } from "bun:test";
import { validateWeeklyReportCollectCommand } from "#src/connection/weekly-report-collect";

test("validateWeeklyReportCollectCommand accepts ready packs and rejects missing markdown", () => {
  const idempotencyKey = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  expect(
    validateWeeklyReportCollectCommand({
      idempotencyKey,
      runId,
      outcome: "ready",
      packMarkdown: "# hi",
    }),
  ).toEqual({ idempotencyKey, runId, outcome: "ready", packMarkdown: "# hi" });
  expect(
    validateWeeklyReportCollectCommand({
      idempotencyKey,
      runId,
      outcome: "ready",
    }),
  ).toBeNull();
  expect(
    validateWeeklyReportCollectCommand({
      idempotencyKey,
      runId,
      outcome: "empty",
    }),
  ).toEqual({ idempotencyKey, runId, outcome: "empty" });
  expect(
    validateWeeklyReportCollectCommand({
      idempotencyKey,
      runId,
      outcome: "failed",
      failureReason: "disk error",
    }),
  ).toEqual({ idempotencyKey, runId, outcome: "failed", failureReason: "disk error" });
});

test("validateWeeklyReportCollectFailRunningCommand accepts turn-fail settle bodies", async () => {
  const { validateWeeklyReportCollectFailRunningCommand } =
    await import("#src/connection/weekly-report-collect");
  const idempotencyKey = "33333333-3333-4333-8333-333333333333";
  expect(
    validateWeeklyReportCollectFailRunningCommand({
      idempotencyKey,
      failRunningSlots: true,
      failureReason: "Error: 405 Not Allowed",
    }),
  ).toEqual({
    idempotencyKey,
    failRunningSlots: true,
    failureReason: "Error: 405 Not Allowed",
  });
  expect(
    validateWeeklyReportCollectFailRunningCommand({
      idempotencyKey,
      failRunningSlots: true,
      failureReason: "",
    }),
  ).toBeNull();
  expect(
    validateWeeklyReportCollectFailRunningCommand({
      idempotencyKey,
      runId: "22222222-2222-4222-8222-222222222222",
      outcome: "failed",
      failureReason: "nope",
    }),
  ).toBeNull();
});
