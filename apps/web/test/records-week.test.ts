import { expect, test } from "bun:test";

import {
  clearReportContent,
  currentIsoWeek,
  emptyReportContent,
  isValidTemplateName,
  hourlySendTimes,
  isHourlySendTime,
  formatRecipientSummary,
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
  expect(isValidTemplateName("WeeklyReportTemplate")).toBe(true);
  expect(isValidTemplateName("WeeklyReportTemplates")).toBe(false);
  expect(isValidTemplateName("")).toBe(false);
});

test("hourly send times are 24 on-the-hour slots", () => {
  expect(hourlySendTimes()[0]).toBe("00:00");
  expect(hourlySendTimes()[12]).toBe("12:00");
  expect(hourlySendTimes()).toHaveLength(24);
  expect(hourlySendTimes()[23]).toBe("23:00");
  expect(isHourlySendTime("15:00")).toBe(true);
  expect(isHourlySendTime("15:30")).toBe(false);
  expect(isHourlySendTime("24:00")).toBe(false);
});

test("recipient summaries match the settings table preview", () => {
  expect(formatRecipientSummary(["刘梦雅", "张昌文", "张亚红", "袁浩"])).toBe(
    "刘梦雅，张昌文，张亚红...+1",
  );
  expect(formatRecipientSummary(["Alice"])).toBe("Alice");
});

test("report body is split into named display pages", () => {
  expect(emptyReportContent()).toEqual({ tabs: { Summary: { markdown: "" } } });
  const content = normalizeReportContent({ markdown: "done item" });
  expect(content.tabs?.Summary?.markdown).toBe("done item");
  expect(clearReportContent(content)).toEqual({ tabs: { Summary: { markdown: "" } } });
});
