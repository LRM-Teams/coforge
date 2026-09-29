import type { QueryClient } from "@tanstack/react-query";

/**
 * The Workspace each QueryClient (one per browser app, one per server request) last showed. Query
 * keys are not scoped by Workspace, so the `/w/$workspaceSlug` layout starts from an empty cache
 * whenever it shows a different one.
 */
const shown = new WeakMap<QueryClient, string>();

export function shownWorkspace(queryClient: QueryClient): string | undefined {
  return shown.get(queryClient);
}

export function markShownWorkspace(queryClient: QueryClient, slug: string): void {
  shown.set(queryClient, slug);
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
