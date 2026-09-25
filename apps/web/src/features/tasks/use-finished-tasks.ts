import { useCallback, useMemo, useState } from "react";
import {
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type { TaskView } from "@lrm/coforge-sdk/internal";

import type { OverviewTaskRow } from "./task-overview-collection";
import type { TaskFilter } from "./task-filters";
import { loadFinishedTaskSummary, loadFinishedTasks } from "./tasks.functions";
import {
  finishedCount,
  finishedRows,
  type FinishedGroup,
  type FinishedStatus,
  type FinishedWindow,
} from "./finished-tasks";

/** Every finished-work read of a Workspace, so one invalidation reads them all again. */
export const finishedTasksKey = (workspaceId: string) => ["task", "finished", workspaceId] as const;

/** Where a board reads finished Tasks: the Workspace Tasks page, or one conversation's Tasks tab. */
export type FinishedTasksScope = { workspaceId: string; conversationId?: string };

/** One board's finished-work reads, under its Workspace's key; its `refresh` reads them again. */
export const finishedTasksScopeKey = ({ workspaceId, conversationId }: FinishedTasksScope) =>
  [...finishedTasksKey(workspaceId), conversationId ?? "workspace"] as const;

/**
 * How long a finished-work read stays fresh.
 *
 * Every real change to these rows arrives as a `task.changed.v1` publication, on which
 * `use-task-overview` (the Tasks page) and `use-conversation-tasks` (a conversation's Tasks tab)
 * invalidate their reads, so freshness does not depend on this
 * number: an invalidation reads again whatever the age. What it suppresses is the redundant
 * re-read of the *same* key — leaving the Tasks page and coming back, a re-render that remounts
 * the panel — which otherwise re-runs the finished counts and refetches every opened page.
 *
 * `refetchOnReconnect: "always"` covers the one case the event cannot: a change published while
 * realtime was disconnected, which would otherwise stay unseen until this window lapsed. It mirrors
 * the realtime-backed activity queries' own choice, and it is deliberately *not* paired with a
 * focus refetch, which the Tasks board is trying to stop paying.
 */
export const FINISHED_TASKS_STALE_MS = 60_000;

export const finishedSummaryQuery = (scope: FinishedTasksScope, window: FinishedWindow) =>
  queryOptions({
    queryKey: [...finishedTasksScopeKey(scope), "summary", window],
    queryFn: () =>
      loadFinishedTaskSummary({ data: { window, conversationId: scope.conversationId } }),
    staleTime: FINISHED_TASKS_STALE_MS,
    refetchOnReconnect: "always",
  });

/** A finished group as the board shows it. */
export type FinishedColumn<T extends TaskView = OverviewTaskRow> = {
  rows: T[];
  /** Every Task in the group under the current picks, not only the loaded ones. */
  count: number;
  hasMore: boolean;
  loading: boolean;
  /** The last read failed; `retry` reads again. */
  failed: boolean;
  retry: () => void;
  loadMore: () => void;
  /** The board says when the group opens: its first page is read only then. */
  onExpandedChange: (expanded: boolean) => void;
};

export type FinishedTasks<T extends TaskView = OverviewTaskRow> = {
  columns: Record<FinishedStatus, FinishedColumn<T>>;
  /** The counted groups, for the owner and Project choices. */
  groups: readonly FinishedGroup[];
  /** Reads the counts and every opened page again, after a Task changed. */
  refresh: () => void;
};

/**
 * Done and Closed for a board: counts for the window, and the pages of each group the viewer has
 * opened, merged with the Tasks the board itself holds in that status (moved there since).
 */
export function useFinishedTasks<T extends TaskView>({
  scope,
  window,
  filter,
  onPage,
}: {
  scope: FinishedTasksScope;
  window: FinishedWindow;
  filter: TaskFilter;
  onPage: readonly T[];
}): FinishedTasks<T | OverviewTaskRow> {
  const queryClient = useQueryClient();
  const summary = useQuery({
    ...finishedSummaryQuery(scope, window),
    // Another window keeps the old counts on screen until its own arrive.
    placeholderData: keepPreviousData,
  });
  const groups = useMemo(() => summary.data?.groups ?? [], [summary.data]);
  const done = useFinishedColumn("done", { scope, window, filter, onPage, groups });
  const closed = useFinishedColumn("closed", { scope, window, filter, onPage, groups });
  const { workspaceId, conversationId } = scope;
  const refresh = useCallback(
    () =>
      void queryClient.invalidateQueries({
        queryKey: finishedTasksScopeKey({ workspaceId, conversationId }),
      }),
    [queryClient, workspaceId, conversationId],
  );
  return useMemo(
    () => ({ columns: { done, closed }, groups, refresh }),
    [done, closed, groups, refresh],
  );
}

function useFinishedColumn<T extends TaskView>(
  status: FinishedStatus,
  {
    scope,
    window,
    filter,
    onPage,
    groups,
  }: {
    scope: FinishedTasksScope;
    window: FinishedWindow;
    filter: TaskFilter;
    onPage: readonly T[];
    groups: readonly FinishedGroup[];
  },
): FinishedColumn<T | OverviewTaskRow> {
  const [expanded, setExpanded] = useState(false);
  const pages = useInfiniteQuery({
    queryKey: [
      ...finishedTasksScopeKey(scope),
      "page",
      status,
      window,
      filter.owners,
      filter.projects,
    ],
    queryFn: ({ pageParam }) =>
      loadFinishedTasks({
        data: {
          conversationId: scope.conversationId,
          status,
          window,
          cursor: pageParam,
          owners: [...filter.owners],
          projects: [...filter.projects],
        },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: expanded,
    staleTime: FINISHED_TASKS_STALE_MS,
    refetchOnReconnect: "always",
  });
  const read = pages.data?.pages;
  const rows = useMemo(
    () =>
      finishedRows<T | OverviewTaskRow>(
        status,
        onPage,
        (read ?? []).flatMap((page) => page.tasks),
      ),
    [status, onPage, read],
  );
  const count = useMemo(() => finishedCount(groups, status, filter), [groups, status, filter]);
  // Pending until its first page arrives, so an opened group never reads as empty before that.
  const { hasNextPage, isFetching, isPending, isError, fetchNextPage, refetch } = pages;
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);
  const retry = useCallback(() => void refetch(), [refetch]);
  return useMemo(
    () => ({
      rows,
      count,
      hasMore: hasNextPage,
      loading: isFetching || isPending,
      failed: isError,
      retry,
      loadMore,
      onExpandedChange: setExpanded,
    }),
    [rows, count, hasNextPage, isFetching, isPending, isError, retry, loadMore],
  );
}
