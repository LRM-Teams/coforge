import type { WorkspaceCatalog } from "./catalog.server";
import type { WorkspaceDeletion } from "./deletion.server";
import type { WorkspaceMemberDirectory } from "./member-directory.server";

/** The Workspace the bare app root (`/`) returns to, as the browser remembers it. */
export type RememberedWorkspace = {
  read(): string | undefined;
  remember(slug: string): void;
  forget(): void;
};

/**
 * A person going out of a Workspace — leaving it, or deleting it — and where they go next: the
 * Workspace `/` remembers when they are still in it, else the first one they are in, else nowhere
 * (`null`). `/` then remembers that one, or forgets the one they went out of. A refused leave or
 * delete changes nothing. The Leave and Delete Workspace server functions are exactly
 * `leave`/`delete` here, which is the seam their tests drive (a Server Function itself needs the
 * Start request context).
 */
export class WorkspaceDeparture {
  constructor(
    private readonly catalog: Pick<WorkspaceCatalog, "selectForUser">,
    private readonly remembered: RememberedWorkspace,
  ) {}

  async leave(
    directory: Pick<WorkspaceMemberDirectory, "leave">,
    input: { workspaceId: string; userId: string },
  ) {
    await directory.leave(input);
    return this.next(input.userId);
  }

  async delete(
    deletion: Pick<WorkspaceDeletion, "delete">,
    input: { workspaceId: string; userId: string; confirmSlug: string },
  ) {
    await deletion.delete(input);
    return this.next(input.userId);
  }

  async next(userId: string): Promise<{ nextWorkspaceSlug: string | null }> {
    const next = await this.catalog.selectForUser(userId, this.remembered.read());
    if (next) this.remembered.remember(next.slug);
    else this.remembered.forget();
    return { nextWorkspaceSlug: next?.slug ?? null };
  }
}
