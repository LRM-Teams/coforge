import { z } from "zod";
import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { privateImageHeaders } from "#src/server/http/image-headers.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import {
  PROFILE_IMAGE_STYLES,
  publicImageVersion,
  publicImageUrl,
  publicImageUrlOrFallback,
  type PublicImageUrlResolver,
} from "#src/server/files/public-image-delivery.server";
import { readUserAvatar } from "#src/server/profiles/user-avatar.server";

/**
 * Where the browser reads the avatar of the person who connected a Computer. The image CDN
 * addresses the object directly; without one, the workspace-scoped route below serves it, which
 * is why that route exists at all. The fallback carries the object's version token (`?v=`) like
 * the other three avatars: it is what makes the route's one-year immutable answer safe — a new
 * upload lands on a new URL. (The fallback only runs with a key, so the token is always there.)
 */
export function computerCreatorAvatarUrl(
  computerId: string,
  workspaceId: string,
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
) {
  return publicImageUrlOrFallback(
    objectKey,
    PROFILE_IMAGE_STYLES.avatar,
    (key) =>
      `/api/computers/${computerId}/creator-avatar?workspaceId=${workspaceId}&v=${encodeURIComponent(publicImageVersion(key))}`,
    publicUrl,
  );
}

const scopeSchema = z.object({ computerId: z.uuid(), workspaceId: z.uuid() });
type Dependencies = {
  authenticate(cookie: string | undefined): { id: string } | Promise<{ id: string }>;
  database(): PrismaClient | null | undefined;
  read(
    db: PrismaClient,
    userId: string,
  ): Promise<{ body: Blob | ReadableStream<Uint8Array>; contentType: string }>;
};

const dependencies: Dependencies = {
  async authenticate(cookie) {
    const user = await optionalBrowserUser(cookie);
    if (!user) throw new AppError("ACCESS_DENIED");
    return user;
  },
  database: getDatabaseClient,
  read: readUserAvatar,
};

export async function handleComputerCreatorAvatar(
  request: Request,
  computerId: string,
  deps = dependencies,
) {
  try {
    const user = await deps.authenticate(request.headers.get("cookie") ?? undefined);
    const scope = scopeSchema.safeParse({
      computerId,
      workspaceId: new URL(request.url).searchParams.get("workspaceId"),
    });
    if (!scope.success) throw new AppError("INVALID_INPUT");
    const db = deps.database();
    if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
    const connection = await db.workspaceComputer.findFirst({
      where: { ...scope.data, workspace: { members: { some: { userId: user.id } } } },
      select: { computer: { select: { ownerId: true } } },
    });
    if (!connection) throw new AppError("NOT_FOUND");
    const avatar = await deps.read(db, connection.computer.ownerId);
    return new Response(avatar.body, {
      headers: privateImageHeaders(avatar.contentType),
    });
  } catch (error) {
    const code = isAppError(error) ? error.code : "INTERNAL_ERROR";
    const status =
      code === "ACCESS_DENIED"
        ? 403
        : code === "NOT_FOUND"
          ? 404
          : code === "INVALID_INPUT"
            ? 400
            : 503;
    return Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
  }
}
