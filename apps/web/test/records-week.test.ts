import { expect, test } from "bun:test";

import {
  clearReportContent,
  currentIsoWeek,
  emptyReportContent,
  isValidTemplateName,
  memberWeekTitle,
  normalizeReportContent,
} from "@/features/records/records-content";

test("formats member week titles like the design catalog", () => {
  expect(memberWeekTitle(2026, 36)).toBe("2026 W36 工作周报");
});

test("resolves the ISO week for a fixed calendar day", () => {
  expect(currentIsoWeek(new Date("2026-09-01T12:00:00+08:00"))).toEqual({
    year: 2026,
    week: 36,
  });
  expect(currentIsoWeek(new Date("2026-09-09T12:00:00+08:00"))).toEqual({
    year: 2026,
    week: 37,
  });
});

test("validates template name budget", () => {
  expect(isValidTemplateName("设计周报")).toBe(true);
  expect(isValidTemplateName("这是一个超过十个汉字的名字啊")).toBe(false);
  expect(isValidTemplateName("")).toBe(false);
});

test("report body is a single markdown document independent of template settings", () => {
  expect(emptyReportContent()).toEqual({ markdown: "" });
  const content = normalizeReportContent({ markdown: "done item" });
  expect(content.markdown).toBe("done item");
  expect(clearReportContent(content)).toEqual({ markdown: "" });
});
