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
) {
  const browserTimeZone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: resolveTimeZone(timeZone, browserTimeZone),
  }).format(new Date(value));
}

function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
