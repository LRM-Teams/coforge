import { describe, expect, test } from "bun:test";

import { calendarDayKey, resolveTimeZone, startOfDay, validateTimeZone } from "#src/lib/dates";

/**
 * The calendar-day rules the chat stream and search filters rely on, pinned in real IANA zones
 * (including a daylight-saving change) so the underlying date arithmetic can change safely.
 */
describe("calendar days in a time zone", () => {
  test("the same instant falls on different days in different zones", () => {
    const instant = new Date("2026-09-24T20:30:00Z");
    expect(calendarDayKey(instant, "UTC")).toBe("2026-09-24");
    expect(calendarDayKey(instant, "Asia/Shanghai")).toBe("2026-09-25");
    expect(calendarDayKey(instant, "America/Los_Angeles")).toBe("2026-09-24");
  });

  test("the start of day is local midnight", () => {
    expect(startOfDay(new Date("2026-09-24T20:30:00Z"), "Asia/Shanghai").toISOString()).toBe(
      "2026-09-24T16:00:00.000Z",
    );
    expect(startOfDay(new Date("2026-09-24T20:30:00Z"), "UTC").toISOString()).toBe(
      "2026-09-24T00:00:00.000Z",
    );
  });

  test("the start of a day with a daylight-saving change uses that morning's offset", () => {
    // New York moves from EDT (-4) to EST (-5) at 02:00 on 2026-11-01; midnight is still EDT.
    expect(startOfDay(new Date("2026-11-01T18:00:00Z"), "America/New_York").toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    // And the day after starts in EST.
    expect(startOfDay(new Date("2026-11-02T18:00:00Z"), "America/New_York").toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
  });
});

describe("time zone preferences", () => {
  test("a valid zone is kept and an invalid one falls back", () => {
    expect(validateTimeZone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(() => validateTimeZone("Mars/Olympus")).toThrow();
    expect(() => validateTimeZone("")).toThrow();
    expect(resolveTimeZone("Mars/Olympus", "Europe/Paris")).toBe("Europe/Paris");
    expect(resolveTimeZone(null, "Mars/Olympus")).toBe("UTC");
  });
});
