import { expect, test } from "bun:test";
import {
  formatCollectWindowLabel,
  isoWeekMonday,
  isValidCollectCustomRange,
  resolveCollectWindow,
} from "@/features/records/weekly-report-collect-window";

test("resolveCollectWindow week is half-open Mon–next Mon", () => {
  const monday = isoWeekMonday(2026, 36);
  expect(monday.toISOString().slice(0, 10)).toBe("2026-08-31");
  const range = resolveCollectWindow({ kind: "week", year: 2026, week: 36 });
  expect(range.windowStart.toISOString()).toBe(monday.toISOString());
  expect(range.windowEnd.getTime() - range.windowStart.getTime()).toBe(7 * 86_400_000);
  expect(formatCollectWindowLabel(range.windowStart, range.windowEnd)).toBe(
    "2026.08.31 - 2026.09.06",
  );
});

test("custom range validates inclusive calendar days", () => {
  expect(isValidCollectCustomRange("2026-08-01", "2026-08-07")).toBe(true);
  expect(isValidCollectCustomRange("2026-08-07", "2026-08-01")).toBe(false);
  const range = resolveCollectWindow({
    kind: "custom",
    customStart: "2026-08-01",
    customEnd: "2026-08-07",
  });
  expect(range.label).toBe("2026.08.01 - 2026.08.07");
});
