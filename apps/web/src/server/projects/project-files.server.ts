import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { configuredGitHub } from "../integrations/github-config.server";
import type { RepositorySelection } from "../integrations/github-connection.server";

/** The repository a Project row links to, or null while any part of the link is missing. */
export function linkedRepositoryOf(project: {
  githubInstallationId: number | null;
  githubRepositoryId: number | null;
  githubFullName: string | null;
}): RepositorySelection | null {
  if (!project.githubFullName || !project.githubInstallationId || !project.githubRepositoryId)
    return null;
  return {
    installationId: project.githubInstallationId,
    repositoryId: project.githubRepositoryId,
    fullName: project.githubFullName,
  };
}

/** Repository file bytes for a Project, read with the requesting User's own GitHub token. */
export class ProjectFiles {
  constructor(private readonly db: PrismaClient) {}

  /** Workspace membership is the CoForge half of the check; GitHub enforces the other half. */
  async download(userId: string, projectId: string, path: string) {
    const project = await this.db.project.findFirst({
      where: { id: projectId, workspace: { members: { some: { userId } } } },
      select: { githubInstallationId: true, githubRepositoryId: true, githubFullName: true },
    });
    const repository = project && linkedRepositoryOf(project);
    if (!repository) throw new AppError("NOT_FOUND");
    const github = await configuredGitHub();
    if (!github) throw new AppError("TEMPORARILY_UNAVAILABLE");
    const file = await github.connection.repositoryRaw(userId, repository, path);
    return { body: file.body, name: path.split("/").pop() || "file" };
  }
}
