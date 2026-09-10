import { useEffect, useState } from "react";

import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { formatDateForDisplay, formatRelativeTime } from "@/lib/dates";
import { getLocale } from "@/paraglide/runtime";

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
  // `now`, the locale and the browser time zone all differ between the server
  // and the client, so anything derived from them is rendered only after mount;
  // the server markup carries the ISO instant, which hydrates without a mismatch.
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const instant = new Date(value);
  const locale = getLocale();
  const exactTime = now ? formatDateForDisplay(instant, timeZone, locale) : instant.toISOString();
  const relative = now ? formatRelativeTime(instant, now, locale) : instant.toISOString();
  const timeElement = (
    <time
      dateTime={instant.toISOString()}
      suppressHydrationWarning
      aria-label={plain ? exactTime : undefined}
      className={plain ? className : undefined}
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
