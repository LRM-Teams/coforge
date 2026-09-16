import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireBrowserUser } from "./require-user.server";

/** Authentication boundary for server functions. Route guards are not enough. */
export const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) =>
  next({
    context: {
      user: requireBrowserUser(getRequest().headers.get("cookie") ?? undefined),
    },
  }),
);
