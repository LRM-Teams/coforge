import { expect, test } from "bun:test";

import {
  RECORDS_SIDEBAR_PREVIEW_LIMIT,
  latestWeeklyHighlight,
  sidebarPreview,
} from "../src/features/records/records-sidebar";

test("latestWeeklyHighlight picks the newest ISO week", () => {
  const latest = latestWeeklyHighlight([
    { id: "w35", year: 2026, week: 35 },
    { id: "w36", year: 2026, week: 36 },
    { id: "prev", year: 2025, week: 52 },
  ]);
  expect(latest?.id).toBe("w36");
});

test("latestWeeklyHighlight is undefined when the catalog has no highlights", () => {
  expect(latestWeeklyHighlight([])).toBeUndefined();
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
