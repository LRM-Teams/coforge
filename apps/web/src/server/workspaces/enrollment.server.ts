import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { WorkspaceCatalog, PrismaWorkspaceCatalogStore } from "./catalog.server";

export type EnrollmentUser = { id: string; username: string; displayName: string };

export type WorkspaceEnrollmentStore = {
  findMembership(userId: string): Promise<string | null>;
  createForUser(input: { slug: string; name: string; userId: string }): Promise<string>;
};

/** Ensures the authenticated User has a WorkspaceMembership, creating their own Workspace when they have none. */
export class WorkspaceEnrollment {
  constructor(private readonly store: WorkspaceEnrollmentStore) {}

  async ensureForUser(
    user: EnrollmentUser,
    acceptLanguage: string,
  ): Promise<{ workspaceId: string }> {
    const existing = await this.store.findMembership(user.id);
    if (existing) return { workspaceId: existing };

    const name = workspaceDisplayName(user.displayName, acceptLanguage);
    const workspaceId = await this.createOwnedWorkspace(user.username, user.id, name);
    return { workspaceId };
  }

  async existingForUser(userId: string): Promise<string | null> {
    return this.store.findMembership(userId);
  }

  private async createOwnedWorkspace(
    username: string,
    userId: string,
    name: string,
  ): Promise<string> {
    try {
      return await this.store.createForUser({ slug: username, name, userId });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
    }
    const suffix = userId.replaceAll("-", "").slice(0, 8);
    return this.store.createForUser({ slug: `${username}-${suffix}`, name, userId });
  }
}

export function workspaceDisplayName(displayName: string, acceptLanguage: string): string {
  const name = displayName.trim() || "User";
  return prefersChinese(acceptLanguage) ? `${name}的工作空间` : `${name}'s Workspace`;
}

export class PrismaWorkspaceEnrollmentStore implements WorkspaceEnrollmentStore {
  constructor(private readonly db: PrismaClient) {}

  async findMembership(userId: string) {
    const row = await this.db.workspaceMembership.findFirst({
      where: { userId },
      select: { workspaceId: true },
      orderBy: [{ workspace: { createdAt: "asc" } }, { workspaceId: "asc" }],
    });
    return row?.workspaceId ?? null;
  }

  async createForUser(input: { slug: string; name: string; userId: string }) {
    const row = await this.db.workspace.create({
      data: {
        slug: input.slug,
        name: input.name,
        members: { create: { userId: input.userId } },
      },
      select: { id: true },
    });
    return row.id;
  }
}

export function findWorkspaceIdForUser(db: PrismaClient, userId: string): Promise<string | null> {
  return new PrismaWorkspaceEnrollmentStore(db).findMembership(userId);
}

export async function requireExistingWorkspaceId(
  db: PrismaClient,
  userId: string,
  preferredSlug?: string,
): Promise<string> {
  const selected = await new WorkspaceCatalog(new PrismaWorkspaceCatalogStore(db)).selectForUser(
    userId,
    preferredSlug,
  );
  if (!selected) throw new AppError("WORKSPACE_REQUIRED");
  return selected.id;
}

export function workspaceIdForUser(
  db: PrismaClient,
  user: { id: string; username: string; name: string },
  acceptLanguage: string,
): Promise<string> {
  return new WorkspaceEnrollment(new PrismaWorkspaceEnrollmentStore(db))
    .ensureForUser({ id: user.id, username: user.username, displayName: user.name }, acceptLanguage)
    .then((result) => result.workspaceId);
}

function prefersChinese(acceptLanguage: string): boolean {
  const tag = preferredLanguageTag(acceptLanguage);
  return tag === "zh" || tag.startsWith("zh-");
}

function preferredLanguageTag(acceptLanguage: string): string {
  let bestTag = "";
  let bestQuality = -1;
  for (const part of acceptLanguage.split(",")) {
    const [rawTag, ...params] = part.trim().split(";");
    if (!rawTag) continue;
    let quality = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key === "q" && value) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) quality = parsed;
      }
    }
    if (quality > bestQuality) {
      bestQuality = quality;
      bestTag = rawTag.trim().toLowerCase();
    }
  }
  return bestTag;
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}
