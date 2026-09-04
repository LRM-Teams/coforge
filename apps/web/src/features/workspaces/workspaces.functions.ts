import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createWorkspaceInputSchema, selectWorkspaceInputSchema } from "./workspace.schemas";

import { AppError } from "../../lib/app-error";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";
import {
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
} from "../../server/workspaces/catalog.server";
import {
  preferredWorkspaceSlugFromRequest,
  writePreferredWorkspaceSlug,
} from "../../server/workspaces/selection.server";

function catalog() {
  const db = getDatabaseClient();
  if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
  return new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db));
}

function currentUser() {
  return requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
}

export const loadWorkspaceSwitcher = createServerFn({ method: "GET" }).handler(async () => {
  const user = currentUser();
  const workspaces = await catalog().listForUser(user.id);
  const current = await catalog().selectForUser(user.id, preferredWorkspaceSlugFromRequest());
  return { workspaces, current };
});

export const selectWorkspace = createServerFn({ method: "POST" })
  .validator(selectWorkspaceInputSchema)
  .handler(async ({ data }) => {
    const user = currentUser();
    const selected = await catalog().selectForUser(user.id, data.slug);
    if (!selected || selected.slug !== data.slug) throw new AppError("ACCESS_DENIED");
    writePreferredWorkspaceSlug(selected.slug);
    return selected;
  });

export const createWorkspace = createServerFn({ method: "POST" })
  .validator(createWorkspaceInputSchema)
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspace = await catalog().createForUser(user.id, data);
    writePreferredWorkspaceSlug(workspace.slug);
    return workspace;
  });
