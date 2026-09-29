import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { declareNoStore } from "#src/features/no-store-response.server";

import { consumeLogoutReturnTo } from "#src/server/auth/browser-login.server";
import { AuthConfigError, readSessionSecret } from "#src/server/auth/config.server";
import { publicOrigin } from "#src/server/http/public-origin.server";

/**
 * The page to sign in to again, for a browser that just came back from Authing after signing out
 * to switch account (`/auth/logout?returnTo=…`), or null. Authing can only send the browser back
 * to the registered homepage, so `/` asks here. The remembering cookie is spent by this call.
 */
export const takeLogoutReturn = createServerFn({ method: "POST" }).handler(async () => {
  declareNoStore();
  const request = getRequest();
  let sessionSecret: string;
  try {
    sessionSecret = await readSessionSecret(process.env);
  } catch (error) {
    if (error instanceof AuthConfigError) return null;
    throw error;
  }
  const landed = consumeLogoutReturnTo({
    sessionSecret,
    cookieHeader: request.headers.get("cookie") ?? "",
    origin: publicOrigin(request),
  });
  if (!landed) return null;
  setResponseHeader("set-cookie", landed.clearCookie);
  return landed.returnTo ?? null;
});
