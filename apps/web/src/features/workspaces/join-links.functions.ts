import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { authMiddleware, workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import { workspaceJoinLinks } from "#src/server/workspaces/join-links-store.server";

const linkOptionsSchema = z.object({
  maxUses: z.number().int().positive().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});
const linkIdInputSchema = z.object({ linkId: z.uuid() });
// Loose on purpose: a malformed token reads as NOT_FOUND like any other invalid link.
const tokenInputSchema = z.object({ token: z.string() });

const toDate = (value: string | null) => (value === null ? null : new Date(value));

/** The Workspace's current join link, or null; owners and admins only. */
export const loadWorkspaceJoinLink = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { user, db, workspaceId } }) =>
    workspaceJoinLinks(db).current({ workspaceId, actorUserId: user.id }),
  );

export const createWorkspaceJoinLink = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(linkOptionsSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) =>
    workspaceJoinLinks(db).create({
      workspaceId,
      actorUserId: user.id,
      maxUses: data.maxUses,
      expiresAt: toDate(data.expiresAt),
    }),
  );

/** "Update link": the old URL stops working and a new link replaces it. */
export const replaceWorkspaceJoinLink = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(linkOptionsSchema.extend(linkIdInputSchema.shape))
  .handler(async ({ data, context: { user, db, workspaceId } }) =>
    workspaceJoinLinks(db).replace({
      workspaceId,
      actorUserId: user.id,
      linkId: data.linkId,
      maxUses: data.maxUses,
      expiresAt: toDate(data.expiresAt),
    }),
  );

export const revokeWorkspaceJoinLink = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(linkIdInputSchema)
  .handler(async ({ data, context: { user, db, workspaceId } }) => {
    await workspaceJoinLinks(db).revoke({ workspaceId, actorUserId: user.id, linkId: data.linkId });
    return { ok: true as const };
  });

/** A link's preview; works signed out, and tells a signed-in viewer whether they are in already. */
export const inspectWorkspaceJoinLink = createServerFn({ method: "GET" })
  .validator(tokenInputSchema)
  .handler(async ({ data }) => {
    declareNoStore();
    const viewer = await optionalBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    return workspaceJoinLinks(requireDatabaseClient()).inspect({
      token: data.token,
      viewerUserId: viewer?.id,
    });
  });

export const joinWorkspaceByLink = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(tokenInputSchema)
  .handler(async ({ data, context }) =>
    workspaceJoinLinks(requireDatabaseClient()).join({
      token: data.token,
      userId: context.user.id,
    }),
  );
