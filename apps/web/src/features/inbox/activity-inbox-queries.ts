import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { loadActivityInbox, loadActivityNavAttention } from "./activity-inbox.functions";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";

/** Every cached page of every view shares this prefix, so one invalidation refreshes them all. */
export const ACTIVITY_INBOX_QUERY_PREFIX = ["activity-inbox"] as const;

/** Every paged list view, and nothing else under the prefix (the nav dot is not paged). */
export const ACTIVITY_INBOX_LISTS_KEY = [...ACTIVITY_INBOX_QUERY_PREFIX, "list"] as const;

/** One view of the viewer's Activity inbox, paged by list offset. */
export const activityInboxQuery = (workspaceId: string, filter: ActivityInboxFilter) =>
  infiniteQueryOptions({
    queryKey: [...ACTIVITY_INBOX_LISTS_KEY, workspaceId, filter],
    queryFn: ({ pageParam }) => loadActivityInbox({ data: { filter, offset: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
  });

export type ActivityInboxPage = Awaited<ReturnType<typeof loadActivityInbox>>;

/** Whether the viewer has unread activity, for the nav rail's Activity dot. Shares the inbox's
 * query prefix, so every list refresh also refreshes the dot. */
export const activityNavAttentionQuery = () =>
  queryOptions({
    queryKey: [...ACTIVITY_INBOX_QUERY_PREFIX, "nav-attention"],
    queryFn: () => loadActivityNavAttention(),
    staleTime: 30_000,
  });
