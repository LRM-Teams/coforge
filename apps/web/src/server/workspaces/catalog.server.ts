import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { generalChannelForCreator } from "#src/server/conversations/public-channels.server";
import {
  isReservedWorkspaceSlug,
  isValidWorkspaceSlug,
} from "#src/features/workspaces/workspace-slug";
import { WORKSPACE_NAME_MAX_LENGTH } from "#src/features/workspaces/workspace.schemas";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { assertCanManageWorkspaceSettings } from "#src/server/workspaces/member-role.server";
import { workspaceIconUrl } from "#src/server/workspaces/workspace-images.server";

export type WorkspaceRecord = { id: string; slug: string; name: string; iconUrl: string | null };

export type WorkspaceCatalogStore = {
  listForUser(userId: string): Promise<WorkspaceRecord[]>;
  createForUser(input: { slug: string; name: string; userId: string }): Promise<WorkspaceRecord>;
  rename(workspaceId: string, name: string): Promise<WorkspaceRecord>;
};

/** The preferred Workspace when the User belongs to it, otherwise their first one. */
export function pickWorkspace<T extends { slug: string }>(
  workspaces: readonly T[],
  preferredSlug?: string,
): T | null {
  if (preferredSlug) {
    const preferred = workspaces.find((workspace) => workspace.slug === preferredSlug);
    if (preferred) return preferred;
  }
  return workspaces[0] ?? null;
}

export class WorkspaceCatalog {
  constructor(private readonly store: WorkspaceCatalogStore) {}

  listForUser(userId: string): Promise<WorkspaceRecord[]> {
    return this.store.listForUser(userId);
  }

  async selectForUser(userId: string, preferredSlug?: string): Promise<WorkspaceRecord | null> {
    return pickWorkspace(await this.store.listForUser(userId), preferredSlug);
  }

  async createForUser(
    userId: string,
    input: { name: string; slug: string },
  ): Promise<WorkspaceRecord> {
    const name = input.name.trim();
    if (!name) throw new AppError("INVALID_INPUT");
    const slug = input.slug.trim();
    if (!isValidWorkspaceSlug(slug) || isReservedWorkspaceSlug(slug))
      throw new AppError("INVALID_INPUT");
    try {
      return await this.store.createForUser({ slug, name, userId });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError("CONFLICT");
      throw new Error("workspace creation failed");
    }
  }

  /** Renames the Workspace; its owner or an admin only. The slug, and so every URL, stays. */
  async rename(workspaceId: string, actorRole: string, name: string): Promise<WorkspaceRecord> {
    assertCanManageWorkspaceSettings(actorRole);
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > WORKSPACE_NAME_MAX_LENGTH) throw new AppError("INVALID_INPUT");
    return this.store.rename(workspaceId, trimmed);
  }
}

const workspaceSelect = { id: true, slug: true, name: true, iconObjectKey: true } as const;

function workspaceRecord(row: {
  id: string;
  slug: string;
  name: string;
  iconObjectKey: string | null;
}): WorkspaceRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    iconUrl: workspaceIconUrl(row.id, row.iconObjectKey),
  };
}

export class PrismaWorkspaceCatalogStore implements WorkspaceCatalogStore {
  constructor(private readonly db: PrismaClient) {}

  async listForUser(userId: string) {
    const rows = await this.db.workspace.findMany({
      where: { members: { some: { userId } } },
      select: workspaceSelect,
      orderBy: { createdAt: "asc" },
    });
    return rows.map(workspaceRecord);
  }

  async createForUser(input: { slug: string; name: string; userId: string }) {
    const row = await this.db.workspace.create({
      data: {
        slug: input.slug,
        name: input.name,
        members: { create: { userId: input.userId, role: "owner" } },
        conversations: generalChannelForCreator(input.userId),
      },
      select: workspaceSelect,
    });
    return workspaceRecord(row);
  }

  async rename(workspaceId: string, name: string) {
    return workspaceRecord(
      await this.db.workspace.update({
        where: { id: workspaceId },
        data: { name },
        select: workspaceSelect,
      }),
    );
  }
}
