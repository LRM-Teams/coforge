import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

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
import { isValidWorkspaceSlug } from "../../server/workspaces/workspace-slug";

function catalog() {
  const db = getDatabaseClient();
  if (!db) throw new Error("Workspace persistence is unavailable");
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
  .validator((data: unknown) => {
    const slug = data && typeof data === "object" ? Reflect.get(data, "slug") : undefined;
    if (typeof slug !== "string" || !isValidWorkspaceSlug(slug))
      throw new Error("workspace slug is invalid");
    return { slug };
  })
  .handler(async ({ data }) => {
    const user = currentUser();
    const selected = await catalog().selectForUser(user.id, data.slug);
    if (!selected || selected.slug !== data.slug) throw new Error("workspace is not available");
    writePreferredWorkspaceSlug(selected.slug);
    return selected;
  });

export const createWorkspace = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("workspace input is required");
    const name = Reflect.get(data, "name");
    const slug = Reflect.get(data, "slug");
    if (typeof name !== "string" || typeof slug !== "string")
      throw new Error("workspace name and slug must be strings");
    return { name, slug };
  })
  .handler(async ({ data }) => {
    const user = currentUser();
    const workspace = await catalog().createForUser(user.id, data);
    writePreferredWorkspaceSlug(workspace.slug);
    return workspace;
  });
