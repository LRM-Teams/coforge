import { expect, test } from "bun:test";
import {
  currentWeekTemplateTitle,
  formatSendWindowCountdown,
  isInWeeklySendWindow,
  isWeeklySendArmed,
  pickPinnedWeekTemplate,
  splitWeeklyTemplateRoles,
  weeklySendWindow,
} from "../src/features/records/weekly-send-window";

test("currentWeekTemplateTitle uses year and week", () => {
  expect(currentWeekTemplateTitle(2026, 36)).toBe("2026 W36 模板");
});

test("splitWeeklyTemplateRoles keeps format templates out of week overviews", () => {
  const split = splitWeeklyTemplateRoles([
    { id: "format", hasAssignments: false },
    { id: "week-38", hasAssignments: true },
  ]);
  expect(split.formats.map((row) => row.id)).toEqual(["format"]);
  expect(split.overviews.map((row) => row.id)).toEqual(["week-38"]);
});

test("pickPinnedWeekTemplate prefers the current ISO week, else the latest overall", () => {
  const templates = [
    { id: "w38", year: 2026, week: 38, createdAtMs: 30 },
    { id: "w37-new", year: 2026, week: 37, createdAtMs: 20 },
    { id: "w37-old", year: 2026, week: 37, createdAtMs: 10 },
  ];
  expect(pickPinnedWeekTemplate(templates, { year: 2026, week: 38 })?.id).toBe("w38");
  expect(pickPinnedWeekTemplate(templates, { year: 2026, week: 37 })?.id).toBe("w37-new");
  expect(pickPinnedWeekTemplate(templates, { year: 2026, week: 39 })?.id).toBe("w38");
});

test("weeklySendWindow is Friday 15:00 through Saturday 00:00 Asia/Shanghai", () => {
  const window = weeklySendWindow({
    now: new Date("2026-09-18T07:30:00.000Z"),
    sendWeekday: 5,
    sendTime: "15:00",
  });
  expect(window?.start.toISOString()).toBe("2026-09-18T07:00:00.000Z");
  expect(window?.end.toISOString()).toBe("2026-09-18T16:00:00.000Z");
});

test("weeklySendWindow for scheduled send covers the whole send weekday", () => {
  const window = weeklySendWindow({
    now: new Date("2026-09-18T01:00:00.000Z"),
    sendWeekday: 5,
    sendTime: "15:00",
    scheduleEnabled: true,
  });
  expect(window?.start.toISOString()).toBe("2026-09-17T16:00:00.000Z");
  expect(window?.end.toISOString()).toBe("2026-09-18T16:00:00.000Z");
});

test("isInWeeklySendWindow is true only after sendTime on the send weekday", () => {
  expect(
    isInWeeklySendWindow({
      now: new Date("2026-09-18T06:59:00.000Z"),
      sendWeekday: 5,
      sendTime: "15:00",
    }),
  ).toBe(false);
  expect(
    isInWeeklySendWindow({
      now: new Date("2026-09-18T07:00:00.000Z"),
      sendWeekday: 5,
      sendTime: "15:00",
    }),
  ).toBe(true);
  expect(
    isInWeeklySendWindow({
      now: new Date("2026-09-17T07:00:00.000Z"),
      sendWeekday: 5,
      sendTime: "15:00",
    }),
  ).toBe(false);
});

test("scheduled send is armed all day on the send weekday before sendTime", () => {
  const fridayMorningShanghai = new Date("2026-09-18T01:00:00.000Z");
  expect(
    isWeeklySendArmed({
      applied: true,
      alreadySent: false,
      sendWeekday: 5,
      sendTime: "15:00",
      scheduleEnabled: true,
      now: fridayMorningShanghai,
    }),
  ).toBe(true);
  expect(
    isWeeklySendArmed({
      applied: true,
      alreadySent: false,
      sendWeekday: 5,
      sendTime: "15:00",
      scheduleEnabled: false,
      now: fridayMorningShanghai,
    }),
  ).toBe(false);
});

test("top chip and send arm gray out after this week's send on the send day", () => {
  const fridayMorningShanghai = new Date("2026-09-18T01:00:00.000Z");
  expect(
    isWeeklySendArmed({
      applied: true,
      alreadySent: false,
      sendWeekday: 5,
      sendTime: "15:00",
      scheduleEnabled: true,
      now: fridayMorningShanghai,
    }),
  ).toBe(true);
  expect(
    isWeeklySendArmed({
      applied: true,
      alreadySent: true,
      sendWeekday: 5,
      sendTime: "15:00",
      scheduleEnabled: true,
      now: fridayMorningShanghai,
    }),
  ).toBe(false);
});

test("isWeeklySendArmed requires applied settings, an open window, and no send yet", () => {
  const fridayInWindow = new Date("2026-09-18T07:30:00.000Z");
  expect(
    isWeeklySendArmed({
      applied: true,
      alreadySent: false,
      sendWeekday: 5,
      sendTime: "15:00",
      now: fridayInWindow,
    }),
  ).toBe(true);
  expect(
    isWeeklySendArmed({
      applied: false,
      alreadySent: false,
      sendWeekday: 5,
      sendTime: "15:00",
      now: fridayInWindow,
    }),
  ).toBe(false);
  expect(
    isWeeklySendArmed({
      applied: true,
      alreadySent: true,
      sendWeekday: 5,
      sendTime: "15:00",
      now: fridayInWindow,
    }),
  ).toBe(false);
});

test("formatSendWindowCountdown pads hours minutes and seconds", () => {
  expect(formatSendWindowCountdown(1 * 3600_000 + 23 * 60_000 + 56_000)).toBe("01:23:56");
});
