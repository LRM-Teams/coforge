import type { WorkspaceCatalog } from "./catalog.server";
import type { WorkspaceMemberDirectory } from "./member-directory.server";

/** The Workspace the bare app root (`/`) returns to, as the browser remembers it. */
export type RememberedWorkspace = {
  read(): string | undefined;
  remember(slug: string): void;
  forget(): void;
};

/**
 * A person leaving a Workspace, and where they go next: the Workspace `/` remembers when they are
 * still in it, else the first one they are in, else nowhere (`null`). `/` then remembers that one,
 * or forgets the one they left. The owner cannot leave (CONFLICT), and nothing changes.
 */
export class WorkspaceDeparture {
  constructor(
    private readonly directory: Pick<WorkspaceMemberDirectory, "leave">,
    private readonly catalog: Pick<WorkspaceCatalog, "selectForUser">,
    private readonly remembered: RememberedWorkspace,
  ) {}

  async leave(input: {
    workspaceId: string;
    userId: string;
  }): Promise<{ nextWorkspaceSlug: string | null }> {
    await this.directory.leave(input);
    const next = await this.catalog.selectForUser(input.userId, this.remembered.read());
    if (next) this.remembered.remember(next.slug);
    else this.remembered.forget();
    return { nextWorkspaceSlug: next?.slug ?? null };
  }
}
