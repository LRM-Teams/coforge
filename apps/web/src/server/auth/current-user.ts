import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { optionalBrowserUser, requireBrowserUser } from "./require-user.server";

export const requireCurrentUser = createServerFn({ method: "GET" }).handler(async () => {
  return requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
});

export const peekCurrentUser = createServerFn({ method: "GET" }).handler(async () => {
  return optionalBrowserUser(getRequest().headers.get("cookie") ?? undefined);
});
