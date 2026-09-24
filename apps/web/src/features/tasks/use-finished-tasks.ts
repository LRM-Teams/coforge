import { useCallback, useMemo, useState } from "react";
import {
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

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

export const finishedSummaryQuery = (workspaceId: string, window: FinishedWindow) =>
  queryOptions({
    queryKey: [...finishedTasksKey(workspaceId), "summary", window],
    queryFn: () => loadFinishedTaskSummary({ data: { window } }),
  });

/** A finished group as the board shows it. */
export type FinishedColumn = {
  rows: OverviewTaskRow[];
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

export type FinishedTasks = {
  columns: Record<FinishedStatus, FinishedColumn>;
  /** The counted groups, for the owner and Project choices. */
  groups: readonly FinishedGroup[];
  /** Reads the counts and every opened page again, after a Task changed. */
  refresh: () => void;
};

/**
 * Done and Closed for the Tasks page: counts for the window, and the pages of each group the
 * viewer has opened, merged with the Tasks the page itself moved into that status.
 */
export function useFinishedTasks({
  workspaceId,
  window,
  filter,
  onPage,
}: {
  workspaceId: string;
  window: FinishedWindow;
  filter: TaskFilter;
  onPage: readonly OverviewTaskRow[];
}): FinishedTasks {
  const queryClient = useQueryClient();
  const summary = useQuery({
    ...finishedSummaryQuery(workspaceId, window),
    // Another window keeps the old counts on screen until its own arrive.
    placeholderData: keepPreviousData,
  });
  const groups = useMemo(() => summary.data?.groups ?? [], [summary.data]);
  const done = useFinishedColumn("done", { workspaceId, window, filter, onPage, groups });
  const closed = useFinishedColumn("closed", { workspaceId, window, filter, onPage, groups });
  const refresh = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: finishedTasksKey(workspaceId) }),
    [queryClient, workspaceId],
  );
  return useMemo(
    () => ({ columns: { done, closed }, groups, refresh }),
    [done, closed, groups, refresh],
  );
}

function useFinishedColumn(
  status: FinishedStatus,
  {
    workspaceId,
    window,
    filter,
    onPage,
    groups,
  }: {
    workspaceId: string;
    window: FinishedWindow;
    filter: TaskFilter;
    onPage: readonly OverviewTaskRow[];
    groups: readonly FinishedGroup[];
  },
): FinishedColumn {
  const [expanded, setExpanded] = useState(false);
  const pages = useInfiniteQuery({
    queryKey: [
      ...finishedTasksKey(workspaceId),
      "page",
      status,
      window,
      filter.owners,
      filter.projects,
    ],
    queryFn: ({ pageParam }) =>
      loadFinishedTasks({
        data: {
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
  });
  const read = pages.data?.pages;
  const rows = useMemo(
    () =>
      finishedRows(
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
