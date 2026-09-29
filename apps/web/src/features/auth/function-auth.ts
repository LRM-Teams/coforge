import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { requireWorkspaceIdForRequest } from "#src/server/workspaces/selection.server";
import type { BrowserUser } from "#src/server/auth/browser-login.server";
import { isValidWorkspaceSlug } from "#src/features/workspaces/workspace-slug";
import { workspaceSlugFromPath } from "#src/features/workspaces/workspace-url";
import { requireBrowserUser } from "#src/server/auth/require-user.server";
import { deLocalizeHref } from "#src/paraglide/runtime";

export type WorkspaceUserContext = {
  user: BrowserUser;
  db: ReturnType<typeof requireDatabaseClient>;
  workspaceId: string;
};

/**
 * Authentication boundary for server functions. Route guards are not enough. A signed-out caller
 * is redirected to /login with the page being opened as `returnTo`: the browser sends its
 * location with each call, and during SSR the page request is the request itself.
 */
export const authMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) =>
    next({
      sendContext: {
        page:
          typeof window === "undefined"
            ? undefined
            : `${window.location.pathname}${window.location.search}`,
      },
    }),
  )
  .server(async ({ next, context }) => {
    const request = getRequest();
    const page = typeof context.page === "string" ? context.page : ssrPage(request);
    return next({
      context: {
        user: await requireBrowserUser(
          request.headers.get("cookie") ?? undefined,
          page === undefined ? undefined : deLocalizeHref(page),
        ),
      },
    });
  });

/** The page an SSR render is for; a call from the browser (`/_serverFn/…`) is not a page. */
function ssrPage(request: Request): string | undefined {
  const url = new URL(request.url);
  const serverFnBase = process.env.TSS_SERVER_FN_BASE ?? "/_serverFn/";
  return url.pathname.startsWith(serverFnBase) ? undefined : `${url.pathname}${url.search}`;
}

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
