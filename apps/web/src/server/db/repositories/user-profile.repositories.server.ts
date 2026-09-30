import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { humanLabel } from "#src/lib/human-label";
import {
  PROFILE_IMAGE_STYLES,
  publicImageUrl,
  publicImageUrlOrFallback,
  versionedImagePath,
  type PublicImageUrlResolver,
} from "#src/server/files/public-image-delivery.server";

export class PrismaUserProfileRepository {
  constructor(private readonly db: PrismaClient) {}

  async get(userId: string) {
    const profile = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        username: true,
        displayName: true,
        fullName: true,
        description: true,
        avatarObjectKey: true,
      },
    });
    if (!profile) throw new AppError("NOT_FOUND");
    return {
      /** The name teammates see for this person (`humanLabel`); never the sign-in provider's. */
      name: humanLabel(profile),
      username: profile.username,
      displayName: profile.displayName,
      description: profile.description,
      avatarUrl: avatarUrl(profile.avatarObjectKey),
    };
  }

  async set(userId: string, input: { name: string; description: string }) {
    const current = await this.db.user.findUnique({
      where: { id: userId },
      select: { username: true, displayName: true, fullName: true },
    });
    if (!current) throw new AppError("NOT_FOUND");
    // The editor is seeded with the label shown today, so saving only the description sends that
    // label back. When the person never set a display name it is a fallback (their full name or
    // their username), not a nickname they chose, and storing it would freeze the fallback as
    // their display name.
    const nameUnchanged = !current.displayName?.trim() && input.name === humanLabel(current);
    const profile = await this.db.user.update({
      where: { id: userId },
      data: {
        ...(nameUnchanged ? {} : { displayName: input.name }),
        description: input.description,
      },
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
  return publicImageUrlOrFallback(
    objectKey,
    PROFILE_IMAGE_STYLES.avatar,
    (key) => versionedImagePath(`/api/me/avatar`, key),
    publicUrl,
  );
}

export function workspaceUserAvatarUrl(
  workspaceId: string,
  userId: string,
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
) {
  return publicImageUrlOrFallback(
    objectKey,
    PROFILE_IMAGE_STYLES.avatar,
    (key) => versionedImagePath(`/api/workspaces/${workspaceId}/users/${userId}/avatar`, key),
    publicUrl,
  );
}
