import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError, isAppError } from "#src/lib/app-error";
import { optionalBrowserUser } from "#src/server/auth/require-user.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { readUserAvatar } from "./user-avatar.server";

export async function handleWorkspaceUserAvatar(
  request: Request,
  workspaceId: string,
  userId: string,
  dependencies: {
    authenticate?: (
      cookie: string | undefined,
    ) => { id: string } | null | Promise<{ id: string } | null>;
    database?: () => PrismaClient | null | undefined;
    read?: typeof readUserAvatar;
  } = {},
) {
  try {
    const authenticate = dependencies.authenticate ?? ((cookie) => optionalBrowserUser(cookie));
    const viewer = await authenticate(request.headers.get("cookie") ?? undefined);
    if (!viewer) throw new AppError("ACCESS_DENIED");
    const db = (dependencies.database ?? getDatabaseClient)();
    if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
    const visible = await db.workspaceMembership.findFirst({
      where: {
        workspaceId,
        userId,
        workspace: { members: { some: { userId: viewer.id } } },
      },
      select: { userId: true },
    });
    if (!visible) throw new AppError("NOT_FOUND");
    const avatar = await (dependencies.read ?? readUserAvatar)(db, userId);
    return new Response(avatar.body, {
      headers: {
        "Content-Type": avatar.contentType,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=31536000, immutable",
        Vary: "Cookie",
      },
    });
  } catch (error) {
    if (!isAppError(error)) throw error;
    const status = error.code === "ACCESS_DENIED" ? 401 : error.code === "NOT_FOUND" ? 404 : 503;
    return Response.json(
      { code: error.code },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
