import { useCallback, useEffect, useMemo } from "react";
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { parseScope, SEARCH_RANGES, type SearchFilters } from "#src/features/search/search-filters";
import { writeLastSearch } from "#src/features/search/search-memory";
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
    // Set by "Search this channel": the filters wait for a query before searching.
    defer: z.literal("1").optional().catch(undefined),
  }),
  component: SearchRoute,
});

function SearchRoute() {
  const { q, senderId, scope, channelId, range, sort, defer } = Route.useSearch();
  const { currentWorkspace, timeZone, user } = appRoute.useLoaderData();
  const workspaceId = currentWorkspace?.id;
  // The search as the URL holds it becomes the last search, for Cmd/Ctrl+K to reopen.
  useEffect(() => {
    if (workspaceId)
      writeLastSearch(workspaceId, user.id, { q, senderId, scope, channelId, range, sort });
  }, [workspaceId, user.id, q, senderId, scope, channelId, range, sort]);
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
      viewerId={user.id}
      deferred={defer === "1"}
      timeZone={timeZone}
      query={q ?? ""}
      filters={filters}
      onQueryChange={onQueryChange}
      onFiltersChange={onFiltersChange}
    />
  );
}
