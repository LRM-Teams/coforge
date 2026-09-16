import { createServerFn } from "@tanstack/react-start";
import { createWorkspaceInputSchema, selectWorkspaceInputSchema } from "./workspace.schemas";

import { AppError } from "../../lib/app-error";
import { authMiddleware, workspaceUserMiddleware } from "../../server/auth/function-auth";
import { requireDatabaseClient } from "../../server/db/client.server";
import {
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
  pickWorkspace,
} from "../../server/workspaces/catalog.server";
import {
  preferredWorkspaceSlugFromRequest,
  writePreferredWorkspaceSlug,
} from "../../server/workspaces/selection.server";
import { WorkspaceMembers } from "../../server/workspaces/members.server";

function catalog() {
  const db = requireDatabaseClient();
  return new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db));
}

export const loadWorkspaceSwitcher = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const user = context.user;
    const workspaces = await catalog().listForUser(user.id);
    const current = pickWorkspace(workspaces, preferredWorkspaceSlugFromRequest());
    return { workspaces, current };
  });

export const listWorkspaceMembers = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    return new WorkspaceMembers(db).list(workspaceId, user.id);
  });

export type WorkspaceMemberDirectory = Awaited<ReturnType<typeof listWorkspaceMembers>>;

export const selectWorkspace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(selectWorkspaceInputSchema)
  .handler(async ({ data, context }) => {
    const user = context.user;
    const selected = await catalog().selectForUser(user.id, data.slug);
    if (!selected || selected.slug !== data.slug) throw new AppError("ACCESS_DENIED");
    writePreferredWorkspaceSlug(selected.slug);
    return selected;
  });

export const createWorkspace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(createWorkspaceInputSchema)
  .handler(async ({ data, context }) => {
    const user = context.user;
    const workspace = await catalog().createForUser(user.id, data);
    writePreferredWorkspaceSlug(workspace.slug);
    return workspace;
  });
