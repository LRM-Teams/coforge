import type { PrismaClient } from "@/generated/prisma/client";
import { AppError } from "@/lib/app-error";
import {
  PROFILE_IMAGE_STYLES,
  publicImageUrl,
  type PublicImageUrlResolver,
} from "@/server/files/public-image-delivery.server";

export class PrismaUserProfileRepository {
  constructor(private readonly db: PrismaClient) {}

  async get(userId: string) {
    const profile = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        username: true,
        displayName: true,
        description: true,
        avatarObjectKey: true,
      },
    });
    if (!profile) throw new AppError("NOT_FOUND");
    return {
      username: profile.username,
      displayName: profile.displayName,
      description: profile.description,
      avatarUrl: avatarUrl(profile.avatarObjectKey),
    };
  }

  async set(userId: string, input: { name: string; description: string }) {
    const profile = await this.db.user.update({
      where: { id: userId },
      data: { displayName: input.name, description: input.description },
      select: { description: true },
    });
    return { name: input.name, description: profile.description };
  }
}

/**
 * Where the browser reads this user's avatar. With an image CDN configured that is the object's
 * own public URL, identical on every render so one cached copy serves every page; without one it
 * is this deployment's authenticated route, versioned by the object id because the bytes behind
 * one avatar id never change.
 */
export function avatarUrl(
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
) {
  if (!objectKey) return null;
  const version = objectKey.split("/").at(-2);
  return (
    publicUrl(objectKey, PROFILE_IMAGE_STYLES.avatar) ??
    `/api/me/avatar?v=${encodeURIComponent(version ?? "current")}`
  );
}

export function workspaceUserAvatarUrl(
  workspaceId: string,
  userId: string,
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
) {
  if (!objectKey) return null;
  const version = objectKey.split("/").at(-2) ?? "current";
  return (
    publicUrl(objectKey, PROFILE_IMAGE_STYLES.avatar) ??
    `/api/workspaces/${workspaceId}/users/${userId}/avatar?v=${encodeURIComponent(version)}`
  );
}
