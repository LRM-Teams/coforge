import { useSyncExternalStore } from "react";
import { useHydrated } from "@tanstack/react-router";

import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { cn } from "#src/lib/utils";
import { formatClockTime, formatDateForDisplay, formatRelativeTime } from "#src/lib/dates";
import { getLocale } from "#src/paraglide/runtime";

import { useTimeFormat } from "#src/lib/time-format-context";

/**
 * One minute clock shared by every `RelativeTime` on the page: a single interval runs while at
 * least one is mounted, instead of one per instance (a timeline renders hundreds). Its snapshot is
 * the current minute, read fresh on every call, so a component mounting after the clock was idle
 * never renders with an old time; the interval only tells subscribers to read it again.
 */
const minuteClock = {
  listeners: new Set<() => void>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  subscribe(listener: () => void) {
    minuteClock.listeners.add(listener);
    minuteClock.timer ??= setInterval(() => {
      for (const notify of minuteClock.listeners) notify();
    }, 60_000);
    return () => {
      minuteClock.listeners.delete(listener);
      if (minuteClock.listeners.size > 0) return;
      clearInterval(minuteClock.timer);
      minuteClock.timer = undefined;
    };
  },
  minute: () => Math.floor(Date.now() / 60_000),
};

/** Re-renders the caller once a minute. The server and the hydrating client cannot agree on
 * `now`, locale or time zone, so callers render time text only once `useHydrated()` is true; the
 * markup before that carries just the ISO instant via `dateTime`. */
function useMinuteTick() {
  return useSyncExternalStore(minuteClock.subscribe, minuteClock.minute, minuteClock.minute);
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
  const hydrated = useHydrated();
  useMinuteTick();
  const instant = new Date(value);
  const locale = getLocale();
  const timeFormat = useTimeFormat();
  // Before hydration the server and client cannot agree on locale or time zone, so render
  // nothing visible yet; the dateTime attribute still carries the instant.
  const exactTime = hydrated ? formatDateForDisplay(instant, timeZone, locale, timeFormat) : "";
  const relative = hydrated ? formatRelativeTime(instant, new Date(), locale) : "";
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
 * waits for hydration and never subscribes to the minute clock.
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
