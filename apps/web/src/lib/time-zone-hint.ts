import { cookiePairs } from "./browser-cookie";
import { isValidTimeZone } from "./dates";

/**
 * The browser's own time zone, remembered in a cookie so the server render can format times in it.
 * A viewer who chose a zone in Settings has it saved with their preferences, and the server knows
 * it; one who follows the browser has nothing the server can read, and the browser's zone is
 * otherwise known only after hydration. The browser writes it once it sees it
 * (`TimeZoneProvider`), and every request after carries it back.
 */

export const TIME_ZONE_HINT_COOKIE = "coforge-time-zone";
export const TIME_ZONE_HINT_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** The zone the browser last remembered, from a `Cookie` header; nothing when it has not, or the
 * cookie is not a zone (it is user input). */
export function timeZoneHintFromCookies(cookieHeader: string | undefined): string | undefined {
  const pair = cookiePairs(cookieHeader).find(([name]) => name === TIME_ZONE_HINT_COOKIE);
  if (!pair) return undefined;
  try {
    const value = decodeURIComponent(pair[1]);
    return value && isValidTimeZone(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
