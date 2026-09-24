import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { listChannelNames } from "#src/features/conversations/channels.functions";
import { loadWorkspaceDirectory } from "#src/features/workspaces/workspaces.functions";
import { messageSearchParams, type SearchFilters } from "./search-filters";
import { searchWorkspaceMessages } from "./search.functions";
import { SEARCH_PAGE_SIZE } from "./search.schemas";

/**
 * One search's pages, keyed by the query and filters as the URL holds them. Time ranges are
 * resolved when a page is fetched (`messageSearchParams`), never in the key, so the key stays
 * stable while the clock moves. Scoped by Workspace so a switch never shows another's results.
 */
export const messageSearchQuery = (
  workspaceId: string,
  query: string,
  filters: SearchFilters,
  timeZone: string | null | undefined,
) =>
  infiniteQueryOptions({
    queryKey: ["message-search", workspaceId, query, filters],
    queryFn: ({ pageParam, signal }) =>
      searchWorkspaceMessages({
        data: {
          ...messageSearchParams(query, filters, new Date(), timeZone),
          offset: pageParam,
          limit: SEARCH_PAGE_SIZE,
        },
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (page, pages) =>
      page.hasMore ? pages.reduce((count, loaded) => count + loaded.results.length, 0) : undefined,
    // Results are a snapshot of the moment the search ran; revisiting the same search within a
    // minute shows it again instead of refetching.
    staleTime: 60_000,
  });

/** The people, Agents and channels the filters offer and name. */
export const searchDirectoryQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["message-search", workspaceId, "directory"],
    queryFn: async () => {
      const [directory, channels] = await Promise.all([
        loadWorkspaceDirectory(),
        listChannelNames(),
      ]);
      return { ...directory, channels };
    },
    staleTime: 5 * 60_000,
  });
