import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { publicOrigin } from "@/server/http/public-origin.server";

/** Where a visitor should install Computer from is per-deployment: someone on staging must
 * not be handed the production one-liner. It is derived from the origin they already reached
 * rather than baked into the bundle or a message catalog. */
export const getInstallOrigin = createServerFn({ method: "GET" }).handler(async () => {
  return publicOrigin(getRequest());
});
