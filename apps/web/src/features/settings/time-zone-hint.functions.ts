import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { timeZoneHintFromCookies } from "#src/lib/time-zone-hint";

/**
 * The browser time zone the last request from it carried, for the render to format times in
 * (`TimeZoneProvider`): the request's cookie on the server, the browser's own after.
 */
export const loadTimeZoneHint = createIsomorphicFn()
  .server(() => timeZoneHintFromCookies(getRequest().headers.get("cookie") ?? undefined))
  .client(() => timeZoneHintFromCookies(document.cookie));
