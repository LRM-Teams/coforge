import { hour12For, type TimeFormat } from "./time-format";

export const DEFAULT_TIME_ZONE = "UTC";

export function validateTimeZone(value: string): string {
  if (!value || !isValidTimeZone(value)) throw new Error("Invalid IANA time zone");
  return value;
}

export function resolveTimeZone(preference: string | null | undefined, browserTimeZone?: string) {
  if (preference && isValidTimeZone(preference)) return preference;
  if (browserTimeZone && isValidTimeZone(browserTimeZone)) return browserTimeZone;
  return DEFAULT_TIME_ZONE;
}

export function formatDateForDisplay(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
  timeFormat: TimeFormat | null = null,
) {
  const browserTimeZone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: hour12For(timeFormat),
    timeZone: resolveTimeZone(timeZone, browserTimeZone),
  }).format(new Date(value));
}

/** The calendar day only (for example "Jul 23, 2026" / "2026年7月23日"), no time of day. */
export function formatCalendarDate(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
) {
  const browserTimeZone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: resolveTimeZone(timeZone, browserTimeZone),
  }).format(new Date(value));
}

/** Absolute wall-clock time with seconds, for contexts that need a fixed timestamp instead of
 * relative text (the Activity timeline's clock column), in the viewer's hour cycle. */
export function formatClockTime(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
  timeFormat: TimeFormat | null = null,
) {
  const browserTimeZone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: hour12For(timeFormat),
    timeZone: resolveTimeZone(timeZone, browserTimeZone),
  }).format(new Date(value));
}

/** A sortable `YYYY-MM-DD` key for the calendar day `value` falls on in `timeZone`, used to
 * detect a day change between two instants (not for display). */
export function calendarDayKey(value: Date | string, timeZone: string | null | undefined) {
  const browserTimeZone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(timeZone, browserTimeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

/** The display label for a date-separator row: the calendar day only, no time. */
export function formatCalendarDayLabel(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
) {
  const browserTimeZone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: resolveTimeZone(timeZone, browserTimeZone),
  }).format(new Date(value));
}

export function formatRelativeTime(
  value: Date | string,
  now = new Date(),
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
) {
  const seconds = (new Date(value).getTime() - now.getTime()) / 1_000;
  const absoluteSeconds = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style: "narrow",
  });
  if (absoluteSeconds < 60) return formatter.format(0, "second");

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["week", 7 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  const [unit, unitSeconds] =
    units.find(([, threshold]) => absoluteSeconds >= threshold) ?? (["minute", 60] as const);
  const amount = Math.sign(seconds) * Math.floor(absoluteSeconds / unitSeconds);
  return formatter.format(amount, unit);
}

function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
