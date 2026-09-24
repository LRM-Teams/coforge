import { infiniteQueryOptions } from "@tanstack/react-query";

import { loadActivityInbox } from "./activity-inbox.functions";
import type { ActivityInboxFilter } from "./activity-inbox.schemas";

/** Every cached page of every view shares this prefix, so one invalidation refreshes them all. */
export const ACTIVITY_INBOX_QUERY_PREFIX = ["activity-inbox"] as const;

/** One view of the viewer's Activity inbox, paged by list offset. */
export const activityInboxQuery = (workspaceId: string, filter: ActivityInboxFilter) =>
  infiniteQueryOptions({
    queryKey: [...ACTIVITY_INBOX_QUERY_PREFIX, workspaceId, filter],
    queryFn: ({ pageParam }) => loadActivityInbox({ data: { filter, offset: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
  });

export type ActivityInboxPage = Awaited<ReturnType<typeof loadActivityInbox>>;
