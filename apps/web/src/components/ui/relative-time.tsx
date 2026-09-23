import { useEffect, useState } from "react";
import { useHydrated } from "@tanstack/react-router";

import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { cn } from "#src/lib/utils";
import { formatClockTime, formatDateForDisplay, formatRelativeTime } from "#src/lib/dates";
import { getLocale } from "#src/paraglide/runtime";

import { useTimeFormat } from "#src/lib/time-format-context";

/** The server and client cannot agree on `now`, locale or time zone before mount, so both
 * `RelativeTime` and `ClockTime` render their live value only after mount; the markup they emit
 * before that carries just the ISO instant via `dateTime`, which hydrates without a mismatch. */
function useClientNow() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function RelativeTime({
  value,
  timeZone,
  className,
  showExact = false,
  plain = false,
}: {
  value: Date | string;
  timeZone?: string | null;
  className?: string;
  showExact?: boolean;
  /**
   * Skip the interactive Tooltip wrapper (which renders a real `<button>`)
   * and expose the exact time as an accessible name only, via `aria-label`
   * (no native `title` attribute — the shared Tooltip component is the only
   * sanctioned way to show a hover affordance in this app, enforced by the
   * `coforge/no-native-title` lint rule). Use this when RelativeTime is
   * nested inside another interactive element (e.g. a row that's itself a
   * `Button`) — nesting a button inside a button is invalid HTML and breaks
   * focus order, so there's no visual hover tooltip in this case, only the
   * accessible name.
   */
  plain?: boolean;
}) {
  const now = useClientNow();
  const instant = new Date(value);
  const locale = getLocale();
  const timeFormat = useTimeFormat();
  // Before mount the server and client cannot agree on locale or time zone, so
  // render nothing visible yet; the dateTime attribute still carries the instant.
  const exactTime = now ? formatDateForDisplay(instant, timeZone, locale, timeFormat) : "";
  const relative = now ? formatRelativeTime(instant, now, locale) : "";
  const timeElement = (
    <time
      dateTime={instant.toISOString()}
      suppressHydrationWarning
      aria-label={plain ? exactTime : undefined}
      className={cn("tabular-nums", plain && className)}
    >
      {relative}
      {showExact && <span className="ml-1.5">· {exactTime}</span>}
    </time>
  );

  if (plain) return timeElement;

  return (
    <Tooltip title={exactTime}>
      <TooltipTrigger className={className} aria-label={exactTime}>
        {timeElement}
      </TooltipTrigger>
    </Tooltip>
  );
}

/**
 * A fixed wall-clock time with seconds, in the viewer's hour cycle, for contexts that need an absolute timestamp
 * instead of `RelativeTime`'s "6h ago" text — the Activity timeline's clock column. Shares
 * `RelativeTime`'s exact-timestamp Tooltip wiring; an absolute time never changes, so it only
 * waits for hydration instead of ticking a per-instance clock (the timeline renders hundreds).
 */
export function ClockTime({
  value,
  timeZone,
  className,
  plain = false,
}: {
  value: Date | string;
  timeZone?: string | null;
  className?: string;
  /** See `RelativeTime`'s `plain`: skip the interactive Tooltip wrapper when already nested
   * inside another interactive element, and expose the exact time via `aria-label` only. */
  plain?: boolean;
}) {
  const hydrated = useHydrated();
  const instant = new Date(value);
  const locale = getLocale();
  const timeFormat = useTimeFormat();
  const exactTime = hydrated ? formatDateForDisplay(instant, timeZone, locale, timeFormat) : "";
  const clock = hydrated ? formatClockTime(instant, timeZone, locale, timeFormat) : "";
  const timeElement = (
    <time
      dateTime={instant.toISOString()}
      suppressHydrationWarning
      aria-label={plain ? exactTime : undefined}
      className={cn("tabular-nums", plain && className)}
    >
      {clock}
    </time>
  );

  if (plain) return timeElement;

  return (
    <Tooltip title={exactTime}>
      <TooltipTrigger className={className} aria-label={exactTime}>
        {timeElement}
      </TooltipTrigger>
    </Tooltip>
  );
}
