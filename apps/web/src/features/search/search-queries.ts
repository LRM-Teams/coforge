import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { listChannelNames } from "#src/features/conversations/channels.functions";
import { loadWorkspaceDirectory } from "#src/features/workspaces/workspaces.functions";
import { messageSearchParams, type SearchFilters } from "./search-filters";
import { searchWorkspaceMessages } from "./search.functions";
import { SEARCH_PAGE_SIZE } from "./search.schemas";

/** Where the next page starts, and the moment the first page was searched at. */
type SearchPageParam = { offset: number; searchedAt?: string };

/**
 * One search's pages, keyed by the query and filters as the URL holds them (the sort only counts
 * with a query, the time zone only for "Today"). The first page fixes the moment the search runs
 * at; every later page reuses it, so its `before` bound and time range never move while paging.
 * Scoped by Workspace so a switch never shows another's results.
 */
export const messageSearchQuery = (
  workspaceId: string,
  query: string,
  filters: SearchFilters,
  timeZone: string | null | undefined,
) =>
  infiniteQueryOptions({
    queryKey: [
      "message-search",
      workspaceId,
      query,
      query ? filters : { ...filters, sort: undefined },
      filters.range === "today" ? (timeZone ?? null) : null,
    ],
    queryFn: async ({ pageParam, signal }) => {
      const searchedAt = pageParam.searchedAt ?? new Date().toISOString();
      const page = await searchWorkspaceMessages({
        data: {
          ...messageSearchParams(query, filters, new Date(searchedAt), timeZone),
          offset: pageParam.offset,
          limit: SEARCH_PAGE_SIZE,
        },
        signal,
      });
      return { ...page, searchedAt };
    },
    initialPageParam: { offset: 0 } as SearchPageParam,
    getNextPageParam: (page, pages): SearchPageParam | undefined =>
      page.hasMore
        ? {
            offset: pages.reduce((count, loaded) => count + loaded.results.length, 0),
            searchedAt: pages[0]!.searchedAt,
          }
        : undefined,
    // Results are a snapshot of the moment the search ran; revisiting the same search within a
    // minute shows it again instead of refetching.
    staleTime: 60_000,
  });

/** The people, Agents and channels the filters offer and name; channels in name order. */
export const searchDirectoryQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: ["search-directory", workspaceId],
    queryFn: async () => {
      const [directory, channels] = await Promise.all([
        loadWorkspaceDirectory(),
        listChannelNames(),
      ]);
      return {
        ...directory,
        channels: [...channels].sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    staleTime: 5 * 60_000,
  });
