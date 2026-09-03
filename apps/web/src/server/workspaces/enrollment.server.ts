import type { PrismaClient } from "../../../generated/client";

export type EnrollmentUser = { id: string; username: string };

export type WorkspaceEnrollmentStore = {
  findMembership(userId: string): Promise<string | null>;
  createWorkspace(input: { slug: string; name: string }): Promise<string>;
  addMember(workspaceId: string, userId: string): Promise<void>;
};

/** Ensures the authenticated User has a WorkspaceMembership, creating their own Workspace when they have none. */
export class WorkspaceEnrollment {
  constructor(private readonly store: WorkspaceEnrollmentStore) {}

  async ensureForUser(user: EnrollmentUser): Promise<{ workspaceId: string }> {
    const existing = await this.store.findMembership(user.id);
    if (existing) return { workspaceId: existing };

    const workspaceId = await this.createOwnedWorkspace(user);
    try {
      await this.store.addMember(workspaceId, user.id);
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
    }
    return { workspaceId };
  }

  private async createOwnedWorkspace(user: EnrollmentUser): Promise<string> {
    try {
      return await this.store.createWorkspace({ slug: user.username, name: user.username });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
    }
    const suffix = user.id.replaceAll("-", "").slice(0, 8);
    return this.store.createWorkspace({
      slug: `${user.username}-${suffix}`,
      name: user.username,
    });
  }
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

  async createWorkspace(input: { slug: string; name: string }) {
    const row = await this.db.workspace.create({
      data: { slug: input.slug, name: input.name },
      select: { id: true },
    });
    return row.id;
  }

  async addMember(workspaceId: string, userId: string) {
    await this.db.workspaceMembership.create({ data: { workspaceId, userId } });
  }
}

export function workspaceIdForUser(db: PrismaClient, user: EnrollmentUser): Promise<string> {
  return new WorkspaceEnrollment(new PrismaWorkspaceEnrollmentStore(db))
    .ensureForUser(user)
    .then((result) => result.workspaceId);
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}
