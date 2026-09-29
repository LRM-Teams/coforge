import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { FileStorage } from "#src/server/files/file-storage.server";
import {
  PROFILE_IMAGE_STYLES,
  publicImageUrl,
  publicImageUrlOrFallback,
  type PublicImageUrlResolver,
  versionedImagePath,
} from "#src/server/files/public-image-delivery.server";
import { getPublicImageStorage } from "#src/server/files/public-image-storage.server";
import { validateImage } from "#src/server/files/image-upload.server";
import { toPublicServerError } from "#src/server/errors/public-error.server";
import { assertCanManageWorkspaceSettings } from "#src/server/workspaces/member-role.server";

/**
 * Where the browser reads a Workspace icon: its own public URL on the image CDN when this
 * deployment has one, otherwise the authenticated route versioned by the object id.
 */
export function workspaceIconUrl(
  workspaceId: string,
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
) {
  return publicImageUrlOrFallback(
    objectKey,
    PROFILE_IMAGE_STYLES.icon,
    (key) => versionedImagePath(`/api/workspaces/${workspaceId}/icon`, key),
    publicUrl,
  );
}

/** The Workspace icon: set by its owner or an admin, read by every member. */
export class WorkspaceImages {
  constructor(
    private readonly db: PrismaClient,
    private readonly storage: () => Promise<FileStorage> = getPublicImageStorage,
  ) {}

  async store(workspaceId: string, userId: string, file: File) {
    const membership = await this.db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true, workspace: { select: { iconObjectKey: true } } },
    });
    assertCanManageWorkspaceSettings(membership?.role);
    await validateImage(file);
    const previousKey = membership!.workspace.iconObjectKey;
    const objectKey = `workspaces/${workspaceId}/icons/${crypto.randomUUID()}/original`;
    const files = await this.storage();
    await files.put(objectKey, file, file.type);
    try {
      // Compare-and-swap on the key this upload replaces: of two concurrent uploads one wins.
      const updated = await this.db.workspace.updateMany({
        where: { id: workspaceId, iconObjectKey: previousKey },
        data: { iconObjectKey: objectKey, iconContentType: file.type },
      });
      if (!updated.count) throw new AppError("CONFLICT");
    } catch (error) {
      await files.remove(objectKey);
      throw error;
    }
    // The new image is already committed; cleanup failure must not undo its result.
    if (previousKey) {
      try {
        await files.remove(previousKey);
      } catch (error) {
        toPublicServerError(error);
      }
    }
    return { iconUrl: workspaceIconUrl(workspaceId, objectKey) };
  }

  async read(userId: string, workspaceId: string) {
    const workspace = await this.db.workspace.findFirst({
      where: { id: workspaceId, members: { some: { userId } } },
      select: { iconObjectKey: true, iconContentType: true },
    });
    if (!workspace?.iconObjectKey || !workspace.iconContentType) throw new AppError("NOT_FOUND");
    const file = await (await this.storage()).open(workspace.iconObjectKey);
    if (!file) throw new AppError("NOT_FOUND");
    return { body: file.body, contentType: workspace.iconContentType };
  }
}
