import { describe, expect, test } from "bun:test";

import { timeZoneHintFromCookies } from "#src/lib/time-zone-hint";
import { browserCookie } from "#src/lib/browser-cookie";

/** What a browser sends back after the page remembered `timeZone`. */
function remembered(timeZone: string) {
  return browserCookie("coforge-time-zone", timeZone, 60, false).split(";")[0]!;
}

describe("the browser time zone the server render formats times in", () => {
  test("comes back from the cookie the browser wrote", () => {
    expect(timeZoneHintFromCookies(`theme=dark; ${remembered("Asia/Shanghai")}`)).toBe(
      "Asia/Shanghai",
    );
    expect(timeZoneHintFromCookies(remembered("America/New_York"))).toBe("America/New_York");
  });

  test("is nothing when the browser has not said, or said something that is no zone", () => {
    expect(timeZoneHintFromCookies(undefined)).toBeUndefined();
    expect(timeZoneHintFromCookies("session=secret")).toBeUndefined();
    for (const value of ["", "Not/AZone", "%E0%A4%A"]) {
      expect(timeZoneHintFromCookies(`coforge-time-zone=${value}`)).toBeUndefined();
    }
  });
});
