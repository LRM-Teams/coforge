import type { QueryClient } from "@tanstack/react-query";

/** A Workspace a page shows: the slug its URL names and its id. */
type ShownWorkspace = { slug: string; id: string };

/**
 * The Workspace each QueryClient (one per browser app, one per server request) last showed. Query
 * keys are not scoped by Workspace, so the `/w/$workspaceSlug` layout starts from an empty cache
 * whenever it shows a different one.
 */
const shown = new WeakMap<QueryClient, ShownWorkspace>();

export function markShownWorkspace(queryClient: QueryClient, workspace: ShownWorkspace): void {
  shown.set(queryClient, workspace);
}

/**
 * What the `/w/$workspaceSlug` layout's `beforeLoad` does on each navigation: the Workspace on
 * screen is already open, so its id is known at once; another one is opened (`open`, which throws
 * when the User is not in it) and replaces the cache. The id goes into the route context, so the
 * pages' loaders key their Workspace-scoped reads without waiting for the layout's loader.
 *
 * A preload runs while the browser URL still names the Workspace on screen: it neither opens the
 * target Workspace (server calls would check it against the one on screen) nor clears what is on
 * screen, and so has no id.
 */
export async function enterWorkspace(
  queryClient: QueryClient,
  slug: string,
  { preload, open }: { preload: boolean; open: () => Promise<{ workspaceId: string }> },
): Promise<{ workspaceId: string | undefined }> {
  const current = shown.get(queryClient);
  if (current?.slug === slug) return { workspaceId: current.id };
  if (preload) return { workspaceId: undefined };
  const { workspaceId } = await open();
  // Query keys are not scoped by Workspace, so moving to another one starts from an empty cache.
  if (current) queryClient.clear();
  shown.set(queryClient, { slug, id: workspaceId });
  return { workspaceId };
}

/**
 * On a page outside every Workspace (`/`): drops the cache of the Workspace shown before, so
 * returning to it later (invited again after leaving) starts empty instead of showing what it
 * held. Going from one Workspace to another is the `/w/$workspaceSlug` layout's own clear.
 */
export function forgetShownWorkspace(queryClient: QueryClient): void {
  if (!shown.has(queryClient)) return;
  queryClient.clear();
  shown.delete(queryClient);
}
