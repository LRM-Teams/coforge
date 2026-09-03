import { describe, expect, test } from "bun:test";

import {
  DEFAULT_TIME_ZONE,
  formatDateForDisplay,
  resolveTimeZone,
  validateTimeZone,
} from "../src/lib/dates";
import {
  UserPreferences,
  type UserPreferencesRepository,
} from "../src/server/db/repositories/user-preferences.repositories.server";

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
    const repository: UserPreferencesRepository = {
      getTimeZone: async () => saved,
      setTimeZone: async (_userId, timeZone) => {
        saved = timeZone;
        return saved;
      },
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
});
