import { expect, test } from "bun:test";

import {
  RECORDS_SIDEBAR_PREVIEW_LIMIT,
  latestWeeklyLanding,
  sidebarPreview,
} from "#src/features/records/records-sidebar";

test("latestWeeklyLanding prefers the first submission on the newest week", () => {
  expect(
    latestWeeklyLanding({
      memberWeeks: [
        {
          year: 2026,
          week: 35,
          overviewReportId: "ov-35",
          submissions: [{ id: "sub-35" }],
        },
        {
          year: 2026,
          week: 36,
          overviewReportId: "ov-36",
          submissions: [{ id: "sub-36a" }, { id: "sub-36b" }],
        },
      ],
    }),
  ).toEqual({ kind: "report", id: "sub-36a" });
});

test("latestWeeklyLanding falls back to overviewReportId when submissions are empty", () => {
  expect(
    latestWeeklyLanding({
      memberWeeks: [
        { year: 2026, week: 38, overviewReportId: "ov-38", submissions: [] },
        {
          year: 2026,
          week: 37,
          overviewReportId: "ov-37",
          submissions: [{ id: "sub-37" }],
        },
      ],
    }),
  ).toEqual({ kind: "report", id: "ov-38" });
});

test("latestWeeklyLanding is undefined when member weeks are empty", () => {
  expect(latestWeeklyLanding({ memberWeeks: [] })).toBeUndefined();
});

test("sidebarPreview hides rows past the design preview limit", () => {
  const items = ["a", "b", "c", "d", "e"];
  expect(sidebarPreview(items, false)).toEqual({
    visible: ["a", "b", "c"],
    hiddenCount: 2,
  });
  expect(RECORDS_SIDEBAR_PREVIEW_LIMIT).toBe(3);
});

test("sidebarPreview shows every row once expanded", () => {
  expect(sidebarPreview(["a", "b", "c", "d"], true)).toEqual({
    visible: ["a", "b", "c", "d"],
    hiddenCount: 0,
  });
});
