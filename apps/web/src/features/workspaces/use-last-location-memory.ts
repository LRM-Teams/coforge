import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";

import { lastLocationCookie } from "./last-location";

/**
 * Remembers each app page the user opens as the place `/` returns to (see `last-location.ts`).
 * Mounted once by the signed-in layout.
 *
 * A page that failed to load (error or not found) is not a place to return to.
 */
export function useLastLocationMemory() {
  const router = useRouter();
  const recordedPath = useRef<string | undefined>(undefined);
  useEffect(() => {
    const remember = () => {
      const path = router.state.location.pathname;
      if (path === recordedPath.current) return;
      // A URL no route matches resolves "successfully" with `_notFound` set, which is how the
      // router itself tells a failed match apart.
      const failed = router.state.matches.some(
        (match) => match.status !== "success" || match._notFound,
      );
      if (failed) return;
      recordedPath.current = path;
      const cookie = lastLocationCookie(path, window.location.protocol === "https:");
      if (cookie) document.cookie = cookie;
    };
    remember();
    return router.subscribe("onResolved", remember);
  }, [router]);
}
