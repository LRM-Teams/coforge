import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { declareNoStore } from "#src/features/no-store-response.server";

import { optionalBrowserUser } from "#src/server/auth/require-user.server";

export const getAuthenticationStatus = createServerFn({ method: "GET" }).handler(async () => {
  declareNoStore();
  return (await optionalBrowserUser(getRequest().headers.get("cookie") ?? undefined)) !== null;
});

/** The signed-in person's email, or null signed out: for pages that work either way. */
export const getSignedInEmail = createServerFn({ method: "GET" }).handler(async () => {
  declareNoStore();
  return (
    (await optionalBrowserUser(getRequest().headers.get("cookie") ?? undefined))?.email ?? null
  );
});
