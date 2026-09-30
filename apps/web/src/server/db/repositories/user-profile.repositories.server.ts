import { hasErrorCode } from "@lrm/coforge-sdk/internal";
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
      /** Only for a caller that needs the handle itself (Records names its viewer by it); no page
       * shows it. */
      username: profile.username,
      fullName: profile.fullName,
      displayName: nickname(profile.fullName, profile.displayName),
      /** False until the person has been asked for their full name (first sign-in). */
      named: profile.fullName !== null,
      description: profile.description,
      avatarUrl: avatarUrl(profile.avatarObjectKey),
    };
  }

  async set(
    userId: string,
    input: { fullName: string; displayName: string | null; description: string },
  ) {
    const displayName = nickname(input.fullName, input.displayName);
    const profile = await this.db.user
      .update({
        where: { id: userId },
        data: { fullName: input.fullName, displayName, description: input.description },
        select: { description: true },
      })
      .catch((error: unknown) => {
        // The signed-in person's row is gone (P2025): the same answer `get` gives.
        throw hasErrorCode(error, "P2025") ? new AppError("NOT_FOUND") : error;
      });
    return {
      name: displayName ?? input.fullName,
      fullName: input.fullName,
      displayName,
      description: profile.description,
    };
  }
}

/** The nickname a person chose: none when they left it empty or wrote their full name again,
 * since the full name is what shows in both cases. */
function nickname(fullName: string | null, displayName: string | null) {
  const chosen = displayName?.trim();
  return chosen && chosen !== fullName?.trim() ? chosen : null;
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
