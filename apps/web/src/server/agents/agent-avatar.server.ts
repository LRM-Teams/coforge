import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { toPublicServerError } from "#src/server/errors/public-error.server";
import type { FileStorage } from "#src/server/files/file-storage.server";
import {
  PROFILE_IMAGE_STYLES,
  publicImageUrl,
  type PublicImageUrlResolver,
} from "#src/server/files/public-image-delivery.server";
import { getPublicImageStorage } from "#src/server/files/public-image-storage.server";
import { validateImage } from "#src/server/files/image-upload.server";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import { agentVisibilityViewerForUser, assertAgentVisible } from "./agent-visibility.server";

/**
 * Where the browser reads an Agent avatar. Same delivery as a User avatar: the image CDN when
 * this deployment has one, otherwise the authenticated Workspace route versioned by the object
 * id. Bytes never live in PostgreSQL.
 */
export function agentAvatarUrl(
  workspaceId: string,
  agentId: string,
  objectKey: string | null,
  publicUrl: PublicImageUrlResolver = publicImageUrl,
) {
  if (!objectKey) return null;
  const version = objectKey.split("/").at(-2) ?? "current";
  return (
    publicUrl(objectKey, PROFILE_IMAGE_STYLES.avatar) ??
    `/api/workspaces/${workspaceId}/agents/${agentId}/avatar?v=${encodeURIComponent(version)}`
  );
}

/**
 * The creator's picture of one Agent. Workspace members may read it; only the creator may
 * replace or remove it. A deleted Agent has no picture to change.
 */
export class AgentAvatars {
  constructor(
    private readonly db: PrismaClient,
    private readonly storage: () => Promise<FileStorage> = getPublicImageStorage,
  ) {}

  async store(workspaceId: string, userId: string, agentId: string, file: File) {
    await validateImage(file);
    const current = await this.#owned(workspaceId, userId, agentId);
    const objectKey = `workspaces/${workspaceId}/agents/${agentId}/avatars/${crypto.randomUUID()}/original`;
    const files = await this.storage();
    await files.put(objectKey, file, file.type);
    try {
      const updated = await this.db.agent.updateMany({
        where: { id: agentId, avatarObjectKey: current.avatarObjectKey },
        data: { avatarObjectKey: objectKey, avatarContentType: file.type },
      });
      if (!updated.count) throw new AppError("CONFLICT");
    } catch (error) {
      await files.remove(objectKey);
      throw error;
    }
    if (current.avatarObjectKey) {
      try {
        await files.remove(current.avatarObjectKey);
      } catch (error) {
        toPublicServerError(error);
      }
    }
    return { avatarUrl: agentAvatarUrl(workspaceId, agentId, objectKey) };
  }

  async remove(workspaceId: string, userId: string, agentId: string) {
    const current = await this.#owned(workspaceId, userId, agentId);
    await this.db.agent.updateMany({
      where: { id: agentId, avatarObjectKey: current.avatarObjectKey },
      data: { avatarObjectKey: null, avatarContentType: null },
    });
    if (current.avatarObjectKey) {
      try {
        await (await this.storage()).remove(current.avatarObjectKey);
      } catch (error) {
        toPublicServerError(error);
      }
    }
  }

  async read(userId: string, workspaceId: string, agentId: string) {
    const viewer = await agentVisibilityViewerForUser(this.db, workspaceId, userId);
    if (!viewer.role) throw new AppError("NOT_FOUND");
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: {
        ownerId: true,
        visibility: true,
        avatarObjectKey: true,
        avatarContentType: true,
      },
    });
    if (!agent) throw new AppError("NOT_FOUND");
    assertAgentVisible(viewer, agent);
    if (!agent.avatarObjectKey || !agent.avatarContentType) throw new AppError("NOT_FOUND");
    const file = await (await this.storage()).open(agent.avatarObjectKey);
    if (!file) throw new AppError("NOT_FOUND");
    return { body: file.body, contentType: agent.avatarContentType };
  }

  async #owned(workspaceId: string, userId: string, agentId: string) {
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { ownerId: true, avatarObjectKey: true },
    });
    if (!agent) throw new AppError("NOT_FOUND");
    if (agent.ownerId !== userId) throw new AppError("ACCESS_DENIED");
    return agent;
  }
}
