import { expect, test } from "bun:test";

import { canEditWeeklyReportContent } from "@/server/records/weekly-report-editability";

test("the member can keep editing their own assignment after send", () => {
  expect(
    canEditWeeklyReportContent({
      viewerUserId: "member-a",
      authorUserId: "member-a",
    }),
  ).toBe(true);
});

test("a Leader cannot edit a member assignment after the member sends it", () => {
  expect(
    canEditWeeklyReportContent({
      viewerUserId: "leader",
      authorUserId: "member-a",
    }),
  ).toBe(false);
});
