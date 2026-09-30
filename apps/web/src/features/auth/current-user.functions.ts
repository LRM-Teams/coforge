import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { accountLabel } from "#src/features/auth/account-label";
import { declareNoStore } from "#src/features/no-store-response.server";

import { optionalBrowserUser } from "#src/server/auth/require-user.server";

export const getAuthenticationStatus = createServerFn({ method: "GET" }).handler(async () => {
  declareNoStore();
  return (await optionalBrowserUser(getRequest().headers.get("cookie") ?? undefined)) !== null;
});

/**
 * How the signed-in person's account is named (`accountLabel`), or null signed out: for pages that
 * work either way. An account with no email is still signed in, so this is not an email.
 */
export const getSignedInAccount = createServerFn({ method: "GET" }).handler(async () => {
  declareNoStore();
  const user = await optionalBrowserUser(getRequest().headers.get("cookie") ?? undefined);
  return user ? accountLabel(user) : null;
});
