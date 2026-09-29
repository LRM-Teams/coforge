import type { WorkspaceCatalog } from "./catalog.server";

/** The Workspace the bare app root (`/`) returns to, as the browser remembers it. */
export type RememberedWorkspace = {
  read(): string | undefined;
  remember(slug: string): void;
  forget(): void;
};

/**
 * Where a person goes once they are out of a Workspace — left it, or deleted it: the Workspace `/`
 * remembers when they are still in it, else the first one they are in, else nowhere (`null`). `/`
 * then remembers that one, or forgets the one they went out of. Called only after going out
 * succeeded, so a refused leave or delete changes nothing.
 */
export class WorkspaceDeparture {
  constructor(
    private readonly catalog: Pick<WorkspaceCatalog, "selectForUser">,
    private readonly remembered: RememberedWorkspace,
  ) {}

  async next(userId: string): Promise<{ nextWorkspaceSlug: string | null }> {
    const next = await this.catalog.selectForUser(userId, this.remembered.read());
    if (next) this.remembered.remember(next.slug);
    else this.remembered.forget();
    return { nextWorkspaceSlug: next?.slug ?? null };
  }
}
