import { createContext, useContext, type ReactNode } from "react";

import { browserTimeZone, resolveTimeZone } from "./dates";

const TimeZoneContext = createContext<string | undefined>(undefined);

/**
 * Supplies the time zone that message times are formatted in: the zone the viewer saved in
 * Settings, else the browser's own. Only Chat's message rows read it, and they render in the
 * browser only.
 */
export function TimeZoneProvider({
  saved,
  children,
}: {
  /** The zone saved with the viewer's preferences; `null` follows the browser. */
  saved: string | null;
  children: ReactNode;
}) {
  return (
    <TimeZoneContext value={resolveTimeZone(saved, browserTimeZone())}>{children}</TimeZoneContext>
  );
}

/** The zone message times show in: the viewer's saved zone, else the browser's. */
export function useTimeZone() {
  return useContext(TimeZoneContext) ?? resolveTimeZone(null, browserTimeZone());
}
