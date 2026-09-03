import type { PrismaClient } from "../../../generated/client";

export type WorkspaceEnrollmentStore = {
  findMembership(userId: string): Promise<string | null>;
  findFirstWorkspace(): Promise<string | null>;
  createWorkspace(input: { slug: string; name: string }): Promise<string>;
  addMember(workspaceId: string, userId: string): Promise<void>;
};

const DEFAULT_WORKSPACE = { slug: "default", name: "Default" } as const;

/** Ensures the authenticated User has a WorkspaceMembership, creating a default Workspace if none exist. */
export class WorkspaceEnrollment {
  constructor(private readonly store: WorkspaceEnrollmentStore) {}

  async ensureForUser(userId: string): Promise<{ workspaceId: string }> {
    const existing = await this.store.findMembership(userId);
    if (existing) return { workspaceId: existing };

    let workspaceId = await this.store.findFirstWorkspace();
    if (!workspaceId) {
      try {
        workspaceId = await this.store.createWorkspace(DEFAULT_WORKSPACE);
      } catch (error) {
        if (!isUniqueConflict(error)) throw error;
        workspaceId = await this.store.findFirstWorkspace();
      }
      if (!workspaceId) throw new Error("could not create a Workspace");
    }

    try {
      await this.store.addMember(workspaceId, userId);
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
    }
    return { workspaceId };
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

  async findFirstWorkspace() {
    const row = await this.db.workspace.findFirst({
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return row?.id ?? null;
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

export function workspaceIdForUser(db: PrismaClient, userId: string): Promise<string> {
  return new WorkspaceEnrollment(new PrismaWorkspaceEnrollmentStore(db))
    .ensureForUser(userId)
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
