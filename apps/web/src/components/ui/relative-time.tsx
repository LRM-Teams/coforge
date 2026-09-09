import { useEffect, useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateForDisplay, formatRelativeTime } from "@/lib/dates";
import { getLocale } from "@/paraglide/runtime";

export function RelativeTime({
  value,
  timeZone,
  className,
  showExact = false,
}: {
  value: Date | string;
  timeZone?: string | null;
  className?: string;
  showExact?: boolean;
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const instant = new Date(value);
  const locale = getLocale();
  const exactTime = formatDateForDisplay(instant, timeZone, locale);
  return (
    <Tooltip>
      <TooltipTrigger className={className} aria-label={exactTime}>
        <time dateTime={instant.toISOString()} suppressHydrationWarning>
          {formatRelativeTime(instant, now, locale)}
          {showExact && <span className="ml-1.5">· {exactTime}</span>}
        </time>
      </TooltipTrigger>
      <TooltipContent>{exactTime}</TooltipContent>
    </Tooltip>
  );
}
