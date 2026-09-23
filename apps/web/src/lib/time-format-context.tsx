import { createContext, useContext, type ReactNode } from "react";

import type { TimeFormat } from "./time-format";

const TimeFormatContext = createContext<TimeFormat | null>(null);

/** Supplies the viewer's saved 12/24-hour choice to every time display below it. */
export function TimeFormatProvider({
  timeFormat,
  children,
}: {
  timeFormat: TimeFormat | null;
  children: ReactNode;
}) {
  return <TimeFormatContext.Provider value={timeFormat}>{children}</TimeFormatContext.Provider>;
}

/** `null` when the viewer has not chosen: formatters then follow the display language. */
export function useTimeFormat() {
  return useContext(TimeFormatContext);
}
