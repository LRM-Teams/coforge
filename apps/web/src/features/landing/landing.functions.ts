import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { publicOrigin } from "@/server/http/public-origin.server";

/** The install entry point is per-deployment: a visitor on staging must not be
 * handed the production one-liner. It is derived from the origin they are
 * already on rather than baked into the bundle or the message catalog. */
export const getInstallScriptUrl = createServerFn({ method: "GET" }).handler(async () => {
  return `${publicOrigin(getRequest())}/computer/install.sh`;
});
