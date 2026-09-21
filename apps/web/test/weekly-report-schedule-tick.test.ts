import { expect, test } from "bun:test";

import {
  WEEKLY_REPORT_SCHEDULE_TICK_ENV,
  readWeeklyReportScheduleTickMs,
  startWeeklyReportScheduleTick,
} from "../src/server/records/weekly-report-schedule-tick.server";

test("readWeeklyReportScheduleTickMs accepts a positive interval and ignores unset", () => {
  expect(readWeeklyReportScheduleTickMs({})).toBeUndefined();
  expect(readWeeklyReportScheduleTickMs({ [WEEKLY_REPORT_SCHEDULE_TICK_ENV]: "60000" })).toBe(
    60_000,
  );
});

test("readWeeklyReportScheduleTickMs rejects non-positive or malformed values", () => {
  expect(() => readWeeklyReportScheduleTickMs({ [WEEKLY_REPORT_SCHEDULE_TICK_ENV]: "0" })).toThrow(
    /positive integer/,
  );
  expect(() =>
    readWeeklyReportScheduleTickMs({ [WEEKLY_REPORT_SCHEDULE_TICK_ENV]: "1.5" }),
  ).toThrow(/positive integer/);
  expect(() =>
    readWeeklyReportScheduleTickMs({ [WEEKLY_REPORT_SCHEDULE_TICK_ENV]: "abc" }),
  ).toThrow(/positive integer/);
});

test("startWeeklyReportScheduleTick runs due work on each interval and skips overlap", async () => {
  const calls: Array<() => void> = [];
  let runCount = 0;
  let release!: () => void;
  const firstRun = new Promise<void>((resolve) => {
    release = resolve;
  });

  const events: Array<Record<string, unknown>> = [];
  const { stop } = startWeeklyReportScheduleTick({
    intervalMs: 10,
    setIntervalFn: (fn) => {
      calls.push(fn);
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    log: (event) => events.push(event),
    runDue: async () => {
      runCount += 1;
      if (runCount === 1) await firstRun;
      return { ok: true, runCount };
    },
  });

  expect(events[0]).toMatchObject({
    event: "weekly_report_schedule_tick_started",
    interval_ms: 10,
  });
  expect(calls).toHaveLength(1);

  calls[0]!();
  calls[0]!();
  expect(runCount).toBe(1);
  expect(events.some((event) => event.event === "weekly_report_schedule_tick_skipped")).toBe(true);

  release();
  await Bun.sleep(0);
  expect(events.some((event) => event.event === "weekly_report_schedule_tick")).toBe(true);

  calls[0]!();
  await Bun.sleep(0);
  expect(runCount).toBe(2);
  stop();
});
