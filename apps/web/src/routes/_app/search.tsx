import { useCallback, useMemo } from "react";
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import {
  SEARCH_RANGES,
  SEARCH_SCOPES,
  type SearchFilters,
  type SearchScope,
} from "#src/features/search/search-filters";
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
    senderId: z.uuid().optional().catch(undefined),
    // Comma-separated (`scope=mentioned,humans`), so the address stays readable.
    scope: z.string().optional().catch(undefined),
    channelId: z.uuid().optional().catch(undefined),
    range: z.enum(SEARCH_RANGES).optional().catch(undefined),
    sort: z.literal("recent").optional().catch(undefined),
  }),
  component: SearchRoute,
});

function parseScope(value: string | undefined): SearchScope[] | undefined {
  const chosen = new Set(value?.split(","));
  const scope = SEARCH_SCOPES.filter((item) => chosen.has(item));
  return scope.length ? scope : undefined;
}

function SearchRoute() {
  const { q, senderId, scope, channelId, range, sort } = Route.useSearch();
  const { currentWorkspace, timeZone } = appRoute.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const filters = useMemo<SearchFilters>(
    () => ({ senderId, scope: parseScope(scope), channelId, range, sort }),
    [senderId, scope, channelId, range, sort],
  );
  // Typing replaces the entry instead of stacking one history step per pause.
  const onQueryChange = useCallback(
    (next: string) =>
      void navigate({
        search: (previous) => ({ ...previous, q: next.trim() ? next : undefined }),
        replace: true,
      }),
    [navigate],
  );
  // A filter change is a step Back can undo.
  const onFiltersChange = useCallback(
    (next: SearchFilters) =>
      void navigate({
        search: (previous) => ({
          q: previous.q,
          senderId: next.senderId,
          scope: next.scope?.join(","),
          channelId: next.channelId,
          range: next.range,
          sort: next.sort,
        }),
      }),
    [navigate],
  );
  if (!currentWorkspace) return null;
  return (
    <SearchPage
      workspaceId={currentWorkspace.id}
      timeZone={timeZone}
      query={q ?? ""}
      filters={filters}
      onQueryChange={onQueryChange}
      onFiltersChange={onFiltersChange}
    />
  );
}
