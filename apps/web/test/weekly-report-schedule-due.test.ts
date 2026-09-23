import { expect, test } from "bun:test";
import {
  isWeeklyScheduleDue,
  zonedWeekdayAndTime,
} from "../src/features/records/weekly-report-schedule-due";

test("zonedWeekdayAndTime reads Friday afternoon in Asia/Shanghai", () => {
  // 2026-09-18 is a Friday; 07:00 UTC = 15:00 Asia/Shanghai
  const parts = zonedWeekdayAndTime(new Date("2026-09-18T07:00:00.000Z"), "Asia/Shanghai");
  expect(parts).toEqual({ weekday: 5, time: "15:00" });
});

test("isWeeklyScheduleDue is true at and after sendTime on the matching weekday", () => {
  const friday1530Shanghai = new Date("2026-09-18T07:30:00.000Z");
  expect(
    isWeeklyScheduleDue({
      now: friday1530Shanghai,
      sendWeekday: 5,
      sendTime: "15:00",
    }),
  ).toBe(true);
  expect(
    isWeeklyScheduleDue({
      now: friday1530Shanghai,
      sendWeekday: 5,
      sendTime: "16:00",
    }),
  ).toBe(false);
});

test("isWeeklyScheduleDue is false on a different weekday", () => {
  // Thursday 15:00 Asia/Shanghai
  const thursday = new Date("2026-09-17T07:00:00.000Z");
  expect(
    isWeeklyScheduleDue({
      now: thursday,
      sendWeekday: 5,
      sendTime: "15:00",
    }),
  ).toBe(false);
});
