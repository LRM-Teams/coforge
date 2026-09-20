import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import type { FileStorage } from "../files/file-storage.server";
import {
  PROFILE_IMAGE_STYLES,
  publicImageUrl,
  type PublicImageUrlResolver,
} from "../files/public-image-delivery.server";
import { getPublicImageStorage } from "../files/public-image-storage.server";
import { validateImage } from "../files/image-upload.server";
import { toPublicServerError } from "../errors/public-error.server";

/**
 * Where the browser reads a project icon: its own public URL on the image CDN when this
 * deployment has one, otherwise the authenticated route versioned by the object id.
 */
export function projectIconUrl(
  projectId: string,
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
) {
  if (!objectKey) return null;
  return (
    publicUrl(objectKey, PROFILE_IMAGE_STYLES.icon) ??
    `/api/projects/${projectId}/icon?v=${encodeURIComponent(objectKey.split("/").at(-2)!)}`
  );
}

export class ProjectImages {
  constructor(
    private readonly db: PrismaClient,
    private readonly storage: () => Promise<FileStorage> = getPublicImageStorage,
  ) {}

  async store(workspaceId: string, userId: string, projectId: string, file: File) {
    await validateImage(file);
    const where = { id: projectId, workspaceId, workspace: { members: { some: { userId } } } };
    const previous = await this.db.project.findFirst({ where, select: { iconObjectKey: true } });
    if (!previous) throw new AppError("NOT_FOUND");
    const objectKey = `workspaces/${workspaceId}/projects/${projectId}/icons/${crypto.randomUUID()}/original`;
    const files = await this.storage();
    await files.put(objectKey, file, file.type);
    try {
      const updated = await this.db.project.updateMany({
        where: { ...where, iconObjectKey: previous.iconObjectKey },
        data: { iconObjectKey: objectKey, iconContentType: file.type },
      });
      if (!updated.count) throw new AppError("CONFLICT");
    } catch (error) {
      await files.remove(objectKey);
      throw error;
    }
    // The new image is already committed; cleanup failure must not undo its result.
    if (previous.iconObjectKey) {
      try {
        await files.remove(previous.iconObjectKey);
      } catch (error) {
        toPublicServerError(error);
      }
    }
    return { iconUrl: projectIconUrl(projectId, objectKey) };
  }

  async read(userId: string, projectId: string) {
    const project = await this.db.project.findFirst({
      where: { id: projectId, workspace: { members: { some: { userId } } } },
      select: { iconObjectKey: true, iconContentType: true },
    });
    if (!project?.iconObjectKey || !project.iconContentType) throw new AppError("NOT_FOUND");
    const file = await (await this.storage()).open(project.iconObjectKey);
    if (!file) throw new AppError("NOT_FOUND");
    return { body: file.body, contentType: project.iconContentType };
  }
}
