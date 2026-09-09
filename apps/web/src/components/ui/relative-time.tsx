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
   * and fall back to the native `title` attribute instead. Use this when
   * RelativeTime is nested inside another interactive element (e.g. a row
   * that's itself a `Button`) — nesting a button inside a button is invalid
   * HTML and breaks focus order.
   */
  plain?: boolean;
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const instant = new Date(value);
  const locale = getLocale();
  const exactTime = formatDateForDisplay(instant, timeZone, locale);
  const timeElement = (
    <time
      dateTime={instant.toISOString()}
      suppressHydrationWarning
      title={plain ? exactTime : undefined}
      className={plain ? className : undefined}
    >
      {formatRelativeTime(instant, now, locale)}
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
