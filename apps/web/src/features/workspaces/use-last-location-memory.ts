import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";

import { lastLocationCookie } from "#src/lib/last-location";

/**
 * Remembers each app page the user opens as the place `/` returns to (see `lib/last-location`).
 * Mounted once by the signed-in layout.
 *
 * Only a page the user moved to counts: switching Workspace re-resolves the same URL under the new
 * Workspace (the URL does not name it), and recording that would pair the new Workspace with the
 * old Workspace's page. A page that failed to load (error or not found) is not a place to return
 * to either.
 */
export function useLastLocationMemory(workspaceSlug: string | undefined) {
  const router = useRouter();
  const recordedPath = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!workspaceSlug) return;
    const remember = () => {
      const path = router.state.location.pathname;
      if (path === recordedPath.current) return;
      if (
        // A URL no route matches resolves "successfully" with `_notFound` set, which is how the
        // router itself tells a failed match apart.
        router.state.matches.some((match) => match.status !== "success" || match._notFound)
      ) {
        return;
      }
      recordedPath.current = path;
      const cookie = lastLocationCookie(
        { workspaceSlug, path },
        window.location.protocol === "https:",
      );
      if (cookie) document.cookie = cookie;
    };
    remember();
    return router.subscribe("onResolved", remember);
  }, [router, workspaceSlug]);
}
