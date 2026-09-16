import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { getFileStorage, type FileStorage } from "../files/file-storage.server";
import { validateImage } from "../files/image-upload.server";

export function projectIconUrl(projectId: string, objectKey: string | null) {
  return objectKey
    ? `/api/projects/${projectId}/icon?v=${encodeURIComponent(objectKey.split("/").at(-2)!)}`
    : null;
}

export class ProjectImages {
  constructor(
    private readonly db: PrismaClient,
    private readonly storage: () => Promise<FileStorage> = getFileStorage,
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
    if (previous.iconObjectKey) await files.remove(previous.iconObjectKey);
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
