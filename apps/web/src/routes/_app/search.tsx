import { useCallback } from "react";
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { SearchPage } from "#src/features/search/search-page";
import { SEARCH_QUERY_MAX_LENGTH } from "#src/features/search/search.schemas";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/search")({
  validateSearch: z.object({
    q: z
      .string()
      .transform((value) => value.slice(0, SEARCH_QUERY_MAX_LENGTH))
      .optional()
      .catch(undefined),
  }),
  component: SearchRoute,
});

function SearchRoute() {
  const { q } = Route.useSearch();
  const workspaceId = appRoute.useLoaderData().currentWorkspace?.id;
  const navigate = useNavigate({ from: Route.fullPath });
  // Typing replaces the entry instead of stacking one history step per pause.
  const onQueryChange = useCallback(
    (next: string) =>
      void navigate({ search: { q: next.trim() ? next : undefined }, replace: true }),
    [navigate],
  );
  if (!workspaceId) return null;
  return <SearchPage workspaceId={workspaceId} query={q ?? ""} onQueryChange={onQueryChange} />;
}
