import type { PrismaClient } from "../../../generated/client";

import { isReservedWorkspaceSlug, isValidWorkspaceSlug } from "./workspace-slug";

export type WorkspaceRecord = { id: string; slug: string; name: string };

export type WorkspaceCatalogStore = {
  listForUser(userId: string): Promise<WorkspaceRecord[]>;
  createForUser(input: { slug: string; name: string; userId: string }): Promise<WorkspaceRecord>;
};

export class WorkspaceCatalog {
  constructor(private readonly store: WorkspaceCatalogStore) {}

  listForUser(userId: string): Promise<WorkspaceRecord[]> {
    return this.store.listForUser(userId);
  }

  async selectForUser(userId: string, preferredSlug?: string): Promise<WorkspaceRecord | null> {
    const workspaces = await this.store.listForUser(userId);
    if (preferredSlug) {
      const preferred = workspaces.find((workspace) => workspace.slug === preferredSlug);
      if (preferred) return preferred;
    }
    return workspaces[0] ?? null;
  }

  async createForUser(
    userId: string,
    input: { name: string; slug: string },
  ): Promise<WorkspaceRecord> {
    const name = input.name.trim();
    if (!name) throw new Error("workspace name is required");
    const slug = input.slug.trim();
    if (!isValidWorkspaceSlug(slug)) throw new Error("workspace slug is invalid");
    if (isReservedWorkspaceSlug(slug)) throw new Error("workspace slug is reserved");
    try {
      return await this.store.createForUser({ slug, name, userId });
    } catch (error) {
      if (isUniqueConflict(error)) throw new Error("workspace slug is taken");
      throw new Error("workspace creation failed");
    }
  }
}

export class PrismaWorkspaceCatalogStore implements WorkspaceCatalogStore {
  constructor(private readonly db: PrismaClient) {}

  async listForUser(userId: string) {
    return this.db.workspace.findMany({
      where: { members: { some: { userId } } },
      select: { id: true, slug: true, name: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async createForUser(input: { slug: string; name: string; userId: string }) {
    return this.db.workspace.create({
      data: {
        slug: input.slug,
        name: input.name,
        members: { create: { userId: input.userId } },
      },
      select: { id: true, slug: true, name: true },
    });
  }
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}
