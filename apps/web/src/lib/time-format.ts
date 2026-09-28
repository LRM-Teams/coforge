/** The viewer's clock: a 12- or 24-hour cycle. `null` follows the display language. */
export const TIME_FORMATS = ["12h", "24h"] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

export function isTimeFormat(value: unknown): value is TimeFormat {
  return TIME_FORMATS.some((format) => format === value);
}

/** `Intl.DateTimeFormat` `hour12` for a preference; `undefined` keeps the locale's own cycle. */
export function hour12For(timeFormat: TimeFormat | null | undefined): boolean | undefined {
  if (timeFormat === "12h") return true;
  if (timeFormat === "24h") return false;
  return undefined;
}

/** The hour cycle a language uses on its own, shown as the choice until the viewer saves one. */
export function localeTimeFormat(locale: string): TimeFormat {
  const { hour12, hourCycle } = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
  }).resolvedOptions();
  return hour12 === false || hourCycle === "h23" || hourCycle === "h24" ? "24h" : "12h";
}
