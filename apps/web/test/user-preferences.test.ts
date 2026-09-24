import { describe, expect, test } from "bun:test";

import {
  DEFAULT_TIME_ZONE,
  formatCalendarDate,
  formatClockTime,
  formatDateForDisplay,
  formatRelativeTime,
  resolveTimeZone,
  validateTimeZone,
} from "#src/lib/dates";
import { localeTimeFormat } from "#src/lib/time-format";
import {
  UserPreferences,
  type UserPreferencesRepository,
} from "#src/server/db/repositories/user-preferences.repositories.server";

describe("user time zone preferences", () => {
  test("uses the browser/system time zone when no preference is saved", () => {
    expect(resolveTimeZone(undefined, "America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(resolveTimeZone(null, "Europe/Berlin")).toBe("Europe/Berlin");
    expect(DEFAULT_TIME_ZONE).toBe("UTC");
  });

  test("accepts a valid IANA time zone and rejects an invalid one", () => {
    expect(validateTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(() => validateTimeZone("not/a-time-zone")).toThrow("Invalid IANA time zone");
  });

  test("saves and reads the selected time zone", async () => {
    let saved: string | null = null;
    let browserNotificationsEnabled = false;
    const repository: UserPreferencesRepository = {
      getTimeZone: async () => saved,
      setTimeZone: async (_userId, timeZone) => {
        saved = timeZone;
        return saved;
      },
      getBrowserNotificationsEnabled: async () => browserNotificationsEnabled,
      setBrowserNotificationsEnabled: async (_userId, enabled) => {
        browserNotificationsEnabled = enabled;
        return enabled;
      },
      getConversationOpenMode: async () => "newest-read",
      setConversationOpenMode: async (_userId, mode) => mode,
      getTimeFormat: async () => null,
      setTimeFormat: async (_userId, timeFormat) => timeFormat,
    };
    const preferences = new UserPreferences(repository);

    expect(await preferences.get("user-1")).toBeNull();
    expect(await preferences.set("user-1", "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(await preferences.get("user-1")).toBe("Asia/Tokyo");
    await expect(preferences.set("user-1", "invalid/time-zone")).rejects.toThrow(
      "Invalid IANA time zone",
    );
    expect(await preferences.set("user-1", null)).toBeNull();
  });

  test("saves the global browser notification preference", async () => {
    let enabled = false;
    const repository: UserPreferencesRepository = {
      getTimeZone: async () => null,
      setTimeZone: async () => null,
      getBrowserNotificationsEnabled: async () => enabled,
      setBrowserNotificationsEnabled: async (_userId, next) => (enabled = next),
      getConversationOpenMode: async () => "newest-read",
      setConversationOpenMode: async (_userId, mode) => mode,
      getTimeFormat: async () => null,
      setTimeFormat: async (_userId, timeFormat) => timeFormat,
    };
    const preferences = new UserPreferences(repository);

    expect(await preferences.getBrowserNotificationsEnabled("user-1")).toBeFalse();
    expect(await preferences.setBrowserNotificationsEnabled("user-1", true)).toBeTrue();
    expect(await preferences.getBrowserNotificationsEnabled("user-1")).toBeTrue();
  });

  test("formats the same instant in the selected time zone", () => {
    // The wall-clock reading is what the preference decides. The separator
    // between date and time belongs to ICU and changes with its CLDR version,
    // so it is not pinned here.
    const instant = "2026-08-31T12:00:00.000Z";
    const losAngeles = formatDateForDisplay(instant, "America/Los_Angeles", "en-US");
    const tokyo = formatDateForDisplay(instant, "Asia/Tokyo", "en-US");

    expect(losAngeles).toContain("Aug 31, 2026");
    expect(losAngeles).toContain("5:00 AM");
    expect(tokyo).toContain("Aug 31, 2026");
    expect(tokyo).toContain("9:00 PM");
  });

  test("formats a calendar date in the viewer's time zone and language, without a time", () => {
    const instant = new Date("2026-07-22T20:00:00.000Z");

    expect(formatCalendarDate(instant, "America/Los_Angeles", "en-US")).toBe("Jul 22, 2026");
    expect(formatCalendarDate(instant, "Asia/Shanghai", "en-US")).toBe("Jul 23, 2026");
    expect(formatCalendarDate(instant, "America/Los_Angeles", "zh-CN")).toBe("2026.07.22");
    expect(formatCalendarDate(instant, "Asia/Shanghai", "zh-CN")).toBe("2026.07.23");
    expect(formatCalendarDate(new Date("2026-01-05T12:00:00.000Z"), "UTC", "zh-CN")).toBe(
      "2026.01.05",
    );
  });

  test("saves a 12- or 24-hour time format, or clears it back to the language default", async () => {
    let saved: string | null = null;
    const preferences = new UserPreferences({
      getTimeZone: async () => null,
      setTimeZone: async () => null,
      getBrowserNotificationsEnabled: async () => false,
      setBrowserNotificationsEnabled: async (_userId, enabled) => enabled,
      getConversationOpenMode: async () => "first-unread",
      setConversationOpenMode: async (_userId, mode) => mode,
      getTimeFormat: async () => saved,
      setTimeFormat: async (_userId, timeFormat) => (saved = timeFormat),
    });

    expect(await preferences.getTimeFormat("user-1")).toBeNull();
    expect(await preferences.setTimeFormat("user-1", "24h")).toBe("24h");
    expect(await preferences.getTimeFormat("user-1")).toBe("24h");
    await expect(preferences.setTimeFormat("user-1", "25h")).rejects.toThrow();
    expect(await preferences.setTimeFormat("user-1", null)).toBeNull();
  });

  test("shows clock times in the chosen hour cycle, or the language's own without a choice", () => {
    const instant = "2026-08-31T13:05:09.000Z";

    expect(formatClockTime(instant, "UTC", "en-US", "24h")).toBe("13:05:09");
    expect(formatClockTime(instant, "UTC", "en-US", "12h")).toMatch(/^01:05:09\sPM$/);
    expect(formatClockTime(instant, "UTC", "en-US", null)).toMatch(/^01:05:09\sPM$/);
    expect(formatClockTime(instant, "UTC", "zh-CN", null)).toBe("13:05:09");
    expect(formatDateForDisplay(instant, "UTC", "en-US", "24h")).toContain("13:05");
    expect(formatDateForDisplay(instant, "UTC", "zh-CN", "12h")).toContain("下午");
  });

  test("offers the display language's own hour cycle until the viewer chooses one", () => {
    expect(localeTimeFormat("en-US")).toBe("12h");
    expect(localeTimeFormat("zh-CN")).toBe("24h");
  });

  test("formats past and future instants with compact localized relative semantics", () => {
    const now = new Date("2026-09-07T12:00:00.000Z");

    expect(formatRelativeTime("2026-09-07T11:41:00.000Z", now, "en")).toBe("19m ago");
    expect(formatRelativeTime("2026-09-07T11:41:00.000Z", now, "zh-CN")).toBe("19分钟前");
    expect(formatRelativeTime("2026-09-07T11:59:30.000Z", now, "en")).toBe("now");
    expect(formatRelativeTime("2026-09-07T14:00:00.000Z", now, "en")).toBe("in 2h");
  });
});
