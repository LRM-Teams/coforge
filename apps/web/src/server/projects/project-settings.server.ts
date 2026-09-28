import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import type { GitHubConnection } from "#src/server/integrations/github-connection.server";
import { getFileStorage, type FileStorage } from "#src/server/files/file-storage.server";
import { toPublicServerError } from "#src/server/errors/public-error.server";

export class ProjectSettings {
  constructor(
    private readonly db: PrismaClient,
    private readonly github?: Pick<GitHubConnection, "accessibleRepositories">,
    private readonly storage: () => Promise<FileStorage> = getFileStorage,
  ) {}

  async update(
    workspaceId: string,
    userId: string,
    input: {
      id: string;
      name: string;
      description: string;
      repository?: { installationId: number; id: number; fullName: string } | null;
      commitCoAuthor: boolean;
    },
  ) {
    const where = {
      id: input.id,
      workspaceId,
      workspace: { members: { some: { userId } } },
    };
    if (!(await this.db.project.findFirst({ where, select: { id: true } })))
      throw new AppError("NOT_FOUND");
    const repository = input.repository;
    if (repository) {
      if (!this.github) throw new AppError("TEMPORARILY_UNAVAILABLE");
      const accessible = await this.github.accessibleRepositories(userId);
      if (
        !accessible.some(
          (item) =>
            item.id === repository.id &&
            item.installationId === repository.installationId &&
            item.fullName === repository.fullName,
        )
      )
        throw new AppError("ACCESS_DENIED");
    }
    const result = await this.db.project.updateMany({
      where,
      data: {
        name: input.name,
        description: input.description,
        commitCoAuthor: input.commitCoAuthor,
        ...(repository !== undefined
          ? {
              githubInstallationId: repository?.installationId ?? null,
              githubRepositoryId: repository?.id ?? null,
              githubFullName: repository?.fullName ?? null,
              githubHtmlUrl: repository ? `https://github.com/${repository.fullName}` : null,
            }
          : {}),
      },
    });
    if (!result.count) throw new AppError("NOT_FOUND");
  }

  async delete(workspaceId: string, userId: string, id: string, confirmation: string) {
    const where = {
      id,
      workspaceId,
      name: confirmation,
      workspace: { members: { some: { userId } } },
    };
    const project = await this.db.project.findFirst({ where, select: { iconObjectKey: true } });
    if (!project) throw new AppError("INVALID_INPUT");
    // The FK's ON DELETE SET NULL preserves channels, memberships and messages.
    // Check the current name in the delete itself so a concurrent rename cannot bypass confirmation.
    const result = await this.db.project.deleteMany({
      where: { ...where, iconObjectKey: project.iconObjectKey },
    });
    if (!result.count) throw new AppError("INVALID_INPUT");
    // Deletion has committed; report storage cleanup separately from the user operation.
    if (project.iconObjectKey) {
      try {
        await (await this.storage()).remove(project.iconObjectKey);
      } catch (error) {
        toPublicServerError(error);
      }
    }
  }
}
