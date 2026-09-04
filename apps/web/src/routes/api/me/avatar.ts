import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import type { PrismaClient } from "../../../../generated/client";
import { AppError, isAppError } from "../../../lib/app-error";
import { optionalBrowserUser } from "../../../server/auth/require-user.server";
import { getDatabaseClient } from "../../../server/db/client.server";
import {
  readUserAvatar,
  removeUserAvatar,
  storeUserAvatar,
} from "../../../server/profiles/user-avatar.server";

const imageUploadSchema = z.object({ file: z.custom<File>(isFile) });

export const Route = createFileRoute("/api/me/avatar")({
  server: {
    handlers: {
      GET: ({ request }) => handleAvatarDownload(request),
      POST: ({ request }) => handleAvatarUpload(request),
      DELETE: ({ request }) => handleAvatarDelete(request),
    },
  },
});

type AvatarDependencies = {
  authenticate(cookieHeader: string | undefined): { id: string };
  database(): PrismaClient | null | undefined;
  store: typeof storeUserAvatar;
  read: typeof readUserAvatar;
  remove: typeof removeUserAvatar;
};

const avatarDependencies: AvatarDependencies = {
  authenticate(cookieHeader) {
    const user = optionalBrowserUser(cookieHeader);
    if (!user) throw new AppError("ACCESS_DENIED");
    return user;
  },
  database: getDatabaseClient,
  store: storeUserAvatar,
  read: readUserAvatar,
  remove: removeUserAvatar,
};

export async function handleAvatarUpload(
  request: Request,
  dependencies: AvatarDependencies = avatarDependencies,
) {
  try {
    const { user, db } = authenticate(request, dependencies);
    const form = await request.formData().catch(() => {
      throw new AppError("INVALID_INPUT");
    });
    const input = imageUploadSchema.safeParse({ file: form.get("file") });
    if (!input.success) throw new AppError("INVALID_INPUT");
    return Response.json(await dependencies.store(db, { userId: user.id, file: input.data.file }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return avatarError(error);
  }
}

export async function handleAvatarDownload(
  request: Request,
  dependencies: AvatarDependencies = avatarDependencies,
) {
  try {
    const { user, db } = authenticate(request, dependencies);
    const avatar = await dependencies.read(db, user.id);
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
    return avatarError(error);
  }
}

export async function handleAvatarDelete(
  request: Request,
  dependencies: AvatarDependencies = avatarDependencies,
) {
  try {
    const { user, db } = authenticate(request, dependencies);
    await dependencies.remove(db, user.id);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return avatarError(error);
  }
}

function authenticate(request: Request, dependencies: AvatarDependencies) {
  const user = dependencies.authenticate(request.headers.get("cookie") ?? undefined);
  const db = dependencies.database();
  if (!db) throw new AppError("TEMPORARILY_UNAVAILABLE");
  return { user, db };
}

function avatarError(error: unknown) {
  if (!isAppError(error)) throw error;
  const status =
    error.code === "ACCESS_DENIED"
      ? 401
      : error.code === "INVALID_INPUT"
        ? 400
        : error.code === "NOT_FOUND"
          ? 404
          : 503;
  return Response.json({ code: error.code }, { status, headers: { "Cache-Control": "no-store" } });
}

function isFile(value: unknown): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "size") === "number" &&
    typeof Reflect.get(value, "arrayBuffer") === "function"
  );
}
