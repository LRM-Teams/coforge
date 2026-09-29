import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { isValidTimeZone } from "./dates";
import { saveBrowserCookie } from "./browser-cookie";
import { TIME_ZONE_HINT_COOKIE, TIME_ZONE_HINT_MAX_AGE_SECONDS } from "./time-zone-hint";

const TimeZoneContext = createContext<string | undefined>(undefined);

/**
 * Supplies the time zone that message times are formatted in, which the server render and the
 * hydrating one must agree on: the zone the viewer saved in Settings, else the browser's, as the
 * cookie the browser last wrote remembers it (`hint`, read from the request). Where neither is
 * known (a browser's first visit), times stay unformatted until the browser reports its zone after
 * hydration; from then on every request carries it.
 */
export function TimeZoneProvider({
  saved,
  hint,
  children,
}: {
  /** The zone saved with the viewer's preferences; `null` follows the browser. */
  saved: string | null;
  /** The browser's zone as its cookie told this request, if it did. */
  hint: string | undefined;
  children: ReactNode;
}) {
  const [browser, setBrowser] = useState(hint);
  useEffect(() => {
    const actual = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!actual || actual === browser || !isValidTimeZone(actual)) return;
    saveBrowserCookie(TIME_ZONE_HINT_COOKIE, actual, TIME_ZONE_HINT_MAX_AGE_SECONDS);
    setBrowser(actual);
  }, [browser]);
  const zone = saved && isValidTimeZone(saved) ? saved : browser;
  return <TimeZoneContext value={zone}>{children}</TimeZoneContext>;
}

/** The zone message times show in; `undefined` while it is not known yet (see the provider). */
export function useTimeZone() {
  return useContext(TimeZoneContext);
}
