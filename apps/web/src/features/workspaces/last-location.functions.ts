import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";

import { restorableLastLocation } from "#src/lib/last-location";
import { preferredWorkspaceSlugFromRequest } from "#src/server/workspaces/selection.server";

/** The page opening `/` returns to (de-localized), or `null` for the default: the last page the
 * browser remembered, when it is still valid for the Workspace the user currently works in. */
export const getLastLocation = createServerFn({ method: "GET" }).handler(async () => {
  setResponseHeader("cache-control", "no-store");
  return (
    restorableLastLocation(
      getRequest().headers.get("cookie") ?? undefined,
      preferredWorkspaceSlugFromRequest(),
    ) ?? null
  );
});
