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

let cachedBrowserTimeZone: string | undefined;

/** The zone a timestamp is shown in: the viewer's saved preference, else the browser's own. The
 * browser zone is read once per page load, like the formatters below that bake it in. */
function displayTimeZone(preference: string | null | undefined) {
  if (preference && isValidTimeZone(preference)) return preference;
  cachedBrowserTimeZone ??=
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  return resolveTimeZone(undefined, cachedBrowserTimeZone);
}

// Building an `Intl.DateTimeFormat` costs far more than formatting with one, and a long list
// formats the same few shapes hundreds of times per render, so each shape is built once.
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  let format = dateTimeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    dateTimeFormats.set(key, format);
  }
  return format;
}

const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();

function relativeTimeFormat(locale: string) {
  let format = relativeTimeFormats.get(locale);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
    relativeTimeFormats.set(locale, format);
  }
  return format;
}

export function formatDateForDisplay(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
  timeFormat: TimeFormat | null = null,
) {
  return dateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: hour12For(timeFormat),
    timeZone: displayTimeZone(timeZone),
  }).format(new Date(value));
}

/** The calendar day only, no time of day: "2026.07.23" in Chinese, the language's own medium
 * date elsewhere (for example "Jul 23, 2026"). */
export function formatCalendarDate(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
) {
  const zone = displayTimeZone(timeZone);
  if (!locale.toLowerCase().startsWith("zh")) {
    return dateTimeFormat(locale, { dateStyle: "medium", timeZone: zone }).format(new Date(value));
  }
  const parts = dateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: zone,
  }).formatToParts(new Date(value));
  const part = (type: "year" | "month" | "day") =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}.${part("month")}.${part("day")}`;
}

/** Absolute wall-clock time with seconds, for contexts that need a fixed timestamp instead of
 * relative text (the Activity timeline's clock column), in the viewer's hour cycle. */
export function formatClockTime(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
  timeFormat: TimeFormat | null = null,
) {
  return dateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: hour12For(timeFormat),
    timeZone: displayTimeZone(timeZone),
  }).format(new Date(value));
}

/** A sortable `YYYY-MM-DD` key for the calendar day `value` falls on in `timeZone`, used to
 * detect a day change between two instants (not for display). */
export function calendarDayKey(value: Date | string, timeZone: string | null | undefined) {
  return dateTimeFormat("en-CA", {
    timeZone: displayTimeZone(timeZone),
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
  return dateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: displayTimeZone(timeZone),
  }).format(new Date(value));
}

export function formatRelativeTime(
  value: Date | string,
  now = new Date(),
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
) {
  const seconds = (new Date(value).getTime() - now.getTime()) / 1_000;
  const absoluteSeconds = Math.abs(seconds);
  const formatter = relativeTimeFormat(locale);
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

// Only accepted zones are remembered: they are a small fixed set, while rejected values can be
// arbitrary user input (`validateTimeZone` runs on the server).
const validTimeZones = new Set<string>();

function isValidTimeZone(value: string) {
  if (validTimeZones.has(value)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    return false;
  }
  validTimeZones.add(value);
  return true;
}
