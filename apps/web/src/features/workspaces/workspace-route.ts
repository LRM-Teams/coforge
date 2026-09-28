import { getRouteApi } from "@tanstack/react-router";

const workspaceRoute = getRouteApi("/w/$workspaceSlug");

/** The Workspace the current page is in (`/w/<slug>/…`); pass it as `params` to in-app links. */
export function useWorkspaceSlug(): string {
  return workspaceRoute.useParams().workspaceSlug;
}
