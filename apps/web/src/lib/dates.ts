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

/** The browser's own zone, read once per page load like the formatters below that bake it in. */
function browserTimeZone() {
  cachedBrowserTimeZone ??=
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  return cachedBrowserTimeZone;
}

// Building an `Intl` formatter costs far more than formatting with one, and a long list formats
// the same few shapes hundreds of times per render, so each shape is built once.
function cached<T>(cache: Map<string, T>, key: string, create: () => T) {
  let value = cache.get(key);
  if (value === undefined) {
    value = create();
    cache.set(key, value);
  }
  return value;
}

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions) {
  return cached(
    dateTimeFormats,
    `${locale}\u0000${JSON.stringify(options)}`,
    () => new Intl.DateTimeFormat(locale, options),
  );
}

const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();

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
    timeZone: resolveTimeZone(timeZone, browserTimeZone()),
  }).format(new Date(value));
}

/** The calendar day only, no time of day: "2026.07.23" in Chinese, the language's own medium
 * date elsewhere (for example "Jul 23, 2026"). */
export function formatCalendarDate(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
) {
  const zone = resolveTimeZone(timeZone, browserTimeZone());
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
    timeZone: resolveTimeZone(timeZone, browserTimeZone()),
  }).format(new Date(value));
}

/** A sortable `YYYY-MM-DD` key for the calendar day `value` falls on in `timeZone`, used to
 * detect a day change between two instants (not for display). */
export function calendarDayKey(value: Date | string, timeZone: string | null | undefined) {
  return zonedDateTime(value, timeZone).toPlainDate().toString();
}

/** The instant the calendar day containing `now` began in `timeZone` (viewer preference, then
 * the browser's zone). Correct across a daylight-saving change earlier that day. */
export function startOfDay(now: Date, timeZone: string | null | undefined): Date {
  return new Date(zonedDateTime(now, timeZone).startOfDay().epochMilliseconds);
}

/** `value` as a moment on the wall clock of `timeZone` (viewer preference, then the browser's). */
function zonedDateTime(value: Date | string, timeZone: string | null | undefined) {
  return Temporal.Instant.fromEpochMilliseconds(new Date(value).getTime()).toZonedDateTimeISO(
    resolveTimeZone(timeZone, browserTimeZone()),
  );
}

/** The display label for a date-separator row: the calendar day only, no time. */
export function formatCalendarDayLabel(
  value: Date | string,
  timeZone: string | null | undefined,
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
) {
  return dateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: resolveTimeZone(timeZone, browserTimeZone()),
  }).format(new Date(value));
}

export function formatRelativeTime(
  value: Date | string,
  now = new Date(),
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
) {
  const seconds = (new Date(value).getTime() - now.getTime()) / 1_000;
  const absoluteSeconds = Math.abs(seconds);
  const formatter = cached(
    relativeTimeFormats,
    locale,
    () => new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" }),
  );
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

// Only canonical zone names are remembered: that set is small and fixed, while other accepted
// spellings (any casing, raw offsets) and rejected values can be arbitrary user input
// (`validateTimeZone` runs on the server).
const canonicalTimeZones = new Set<string>();

function isValidTimeZone(value: string) {
  if (canonicalTimeZones.has(value)) return true;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  if (resolved === value) canonicalTimeZones.add(value);
  return true;
}
