import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createWorkspaceInputSchema, selectWorkspaceInputSchema } from "./workspace.schemas";

import { AppError } from "@/lib/app-error";
import { authMiddleware, workspaceUserMiddleware } from "@/features/auth/function-auth";
import { requireDatabaseClient } from "@/server/db/client.server";
import {
  PrismaWorkspaceCatalogStore,
  WorkspaceCatalog,
  pickWorkspace,
} from "@/server/workspaces/catalog.server";
import {
  preferredWorkspaceSlugFromRequest,
  writePreferredWorkspaceSlug,
} from "@/server/workspaces/selection.server";
import { WorkspaceMembers } from "@/server/workspaces/members.server";
import { MEMBER_PAGE_MAX, NO_COMPUTER } from "./member-directory";

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

export const loadMemberDirectorySummary = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    return new WorkspaceMembers(db).summary(workspaceId, user.id);
  });

export type MemberDirectorySummary = Awaited<ReturnType<typeof loadMemberDirectorySummary>>;

const pageInput = {
  query: z.string().max(200).default(""),
  cursor: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(MEMBER_PAGE_MAX),
};

export const loadMemberAgentPage = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({
      ...pageInput,
      owner: z.enum(["all", "mine"]),
      computer: z.union([z.string().uuid(), z.literal(NO_COMPUTER)]).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { user, db, workspaceId } = context;
    return new WorkspaceMembers(db).agentPage(workspaceId, user.id, data);
  });

export type MemberAgent = Awaited<ReturnType<typeof loadMemberAgentPage>>["items"][number];

export const loadMemberPeoplePage = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object(pageInput))
  .handler(async ({ data, context }) => {
    const { user, db, workspaceId } = context;
    return new WorkspaceMembers(db).peoplePage(workspaceId, user.id, data);
  });

export type MemberPerson = Awaited<ReturnType<typeof loadMemberPeoplePage>>["items"][number];

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
