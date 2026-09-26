import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { declareNoStore } from "#src/features/no-store-response.server";

import { optionalBrowserUser } from "#src/server/auth/require-user.server";

export const getAuthenticationStatus = createServerFn({ method: "GET" }).handler(async () => {
  declareNoStore();
  return (await optionalBrowserUser(getRequest().headers.get("cookie") ?? undefined)) !== null;
});
