import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireDatabaseClient } from "../db/client.server";
import { requireWorkspaceIdForRequest } from "../workspaces/selection.server";
import type { BrowserUser } from "./browser-login.server";
import { requireBrowserUser } from "./require-user.server";

export type WorkspaceUserContext = {
  user: BrowserUser;
  db: ReturnType<typeof requireDatabaseClient>;
  workspaceId: string;
};

/** Authentication boundary for server functions. Route guards are not enough. */
export const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) =>
  next({
    context: {
      user: requireBrowserUser(getRequest().headers.get("cookie") ?? undefined),
    },
  }),
);

/**
 * Server functions called by a signed-in User (browser session) inside a Workspace. Agents
 * authenticate separately through agentAuthMiddleware. Resolves the database
 * and the caller's selected Workspace once so handlers start from
 * `{ user, db, workspaceId }` instead of repeating the lookup.
 */
export const workspaceUserMiddleware = createMiddleware({ type: "function" })
  .middleware([authMiddleware])
  .server(async ({ next, context }) => {
    const db = requireDatabaseClient();
    const workspaceId = await requireWorkspaceIdForRequest(db, context.user.id);
    return next({ context: { db, workspaceId } });
  });
