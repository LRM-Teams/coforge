import { infiniteQueryOptions } from "@tanstack/react-query";

import { searchWorkspaceMessages } from "./search.functions";
import { SEARCH_PAGE_SIZE, type MessageSearchParams } from "./search.schemas";

/** Scoped by Workspace so a Workspace switch never shows the previous Workspace's results. */
export const messageSearchQuery = (
  workspaceId: string,
  params: Omit<MessageSearchParams, "offset" | "limit">,
) =>
  infiniteQueryOptions({
    queryKey: ["message-search", workspaceId, params],
    queryFn: ({ pageParam, signal }) =>
      searchWorkspaceMessages({
        data: { ...params, offset: pageParam, limit: SEARCH_PAGE_SIZE },
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (page, pages) =>
      page.hasMore ? pages.reduce((count, loaded) => count + loaded.results.length, 0) : undefined,
    // Results are a snapshot of the moment the search ran; revisiting the same search within a
    // minute shows it again instead of refetching.
    staleTime: 60_000,
  });
