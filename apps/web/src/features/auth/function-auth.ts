import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { requireWorkspaceIdForRequest } from "#src/server/workspaces/selection.server";
import type { BrowserUser } from "#src/server/auth/browser-login.server";
import { isValidWorkspaceSlug } from "#src/features/workspaces/workspace-slug";
import { workspaceSlugFromPath } from "#src/features/workspaces/workspace-url";
import { requireBrowserUser } from "#src/server/auth/require-user.server";

export type WorkspaceUserContext = {
  user: BrowserUser;
  db: ReturnType<typeof requireDatabaseClient>;
  workspaceId: string;
};

/** Authentication boundary for server functions. Route guards are not enough. */
export const authMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) =>
  next({
    context: {
      user: await requireBrowserUser(getRequest().headers.get("cookie") ?? undefined),
    },
  }),
);

/**
 * Server functions called by a signed-in User (browser session) inside a Workspace. Agents
 * authenticate separately through agentAuthMiddleware. Resolves the database
 * and the caller's Workspace once so handlers start from
 * `{ user, db, workspaceId }` instead of repeating the lookup.
 *
 * The Workspace is the one the page URL names (`/w/<slug>`): the browser sends it with each call
 * (a call's own request is `/_serverFn/…`), and during SSR it is read from the page request. It
 * is only a claim until `requireWorkspaceIdForRequest` finds the signed-in User is a member.
 */
export const workspaceUserMiddleware = createMiddleware({ type: "function" })
  .middleware([authMiddleware])
  .client(async ({ next }) =>
    next({
      sendContext: {
        workspaceSlug:
          typeof window === "undefined"
            ? undefined
            : workspaceSlugFromPath(window.location.pathname),
      },
    }),
  )
  .server(async ({ next, context }) => {
    const db = requireDatabaseClient();
    // Client-sent, so only a well-formed claim here; membership decides the rest.
    const sent = context.workspaceSlug;
    const workspaceId = await requireWorkspaceIdForRequest(
      db,
      context.user.id,
      typeof sent === "string" && isValidWorkspaceSlug(sent) ? sent : undefined,
    );
    return next({ context: { db, workspaceId } });
  });
