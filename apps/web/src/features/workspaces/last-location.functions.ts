import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getRequest } from "@tanstack/react-start/server";
import { declareNoStore } from "#src/features/no-store-response.server";
import { authMiddleware } from "#src/features/auth/function-auth";
import { requireDatabaseClient } from "#src/server/db/client.server";
import {
  pickWorkspace,
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
} from "#src/server/workspaces/catalog.server";
import { preferredWorkspaceSlugFromRequest } from "#src/server/workspaces/selection.server";
import { restorableLastLocation } from "./last-location";
import { splitWorkspacePath, workspacePath } from "#src/features/workspaces/workspace-url";

/**
 * The page opening `/` goes to (de-localized): the last page the browser remembered (unless
 * `resume` is off), else the home of the Workspace the User last opened (or their first one);
 * `null` when they have none.
 */
export const getStartPage = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator(z.object({ resume: z.boolean() }))
  .handler(async ({ data, context }) => {
    declareNoStore();
    const workspaces = await new WorkspaceCatalog(
      new PrismaWorkspaceCatalogStore(requireDatabaseClient()),
    ).listForUser(context.user.id);
    const remembered = data.resume
      ? restorableLastLocation(getRequest().headers.get("cookie") ?? undefined)
      : undefined;
    // Only a page in a Workspace the User is still in; one they left would be a 404.
    const rememberedSlug = remembered && splitWorkspacePath(remembered)?.slug;
    if (remembered && workspaces.some((workspace) => workspace.slug === rememberedSlug))
      return remembered;
    const workspace = pickWorkspace(workspaces, preferredWorkspaceSlugFromRequest());
    return workspace ? workspacePath(workspace.slug) : null;
  });
