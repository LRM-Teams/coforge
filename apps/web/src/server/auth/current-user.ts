import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";

import { optionalBrowserUser } from "./require-user.server";

export const getAuthenticationStatus = createServerFn({ method: "GET" }).handler(async () => {
  setResponseHeader("cache-control", "no-store");
  return (await optionalBrowserUser(getRequest().headers.get("cookie") ?? undefined)) !== null;
});
