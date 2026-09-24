import { useMemo } from "react";
import { useHydrated } from "@tanstack/react-router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  createTaskOverview,
  taskOverviewQuery,
  type OverviewTaskRow,
  type TaskOverviewCollection,
} from "./task-overview-collection";

// React access to the Tasks page's rows (`task-overview-collection.ts`).

const overviewsByClient = new WeakMap<QueryClient, Map<string, TaskOverviewCollection>>();

/** One overview (collection and commands) per `QueryClient` and Workspace, so every consumer
 * shares one sync and one optimistic state. */
function overviewFor(queryClient: QueryClient, workspaceId: string) {
  let byWorkspace = overviewsByClient.get(queryClient);
  if (!byWorkspace) overviewsByClient.set(queryClient, (byWorkspace = new Map()));
  let overview = byWorkspace.get(workspaceId);
  if (!overview)
    byWorkspace.set(workspaceId, (overview = createTaskOverview(queryClient, workspaceId)));
  return overview;
}

/**
 * The Tasks page's rows, how to run a command on one, and how to read them again. Server-rendered
 * from the Query cache the loader fills; after hydration read live from the collection.
 */
export function useTaskOverview() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  // Only a new read re-renders from this: after hydration the rows come from the collection.
  const cache = useSuspenseQuery({
    ...taskOverviewQuery(workspaceId),
    notifyOnChangeProps: ["dataUpdatedAt"],
  }).data;
  const hydrated = useHydrated();
  const overview = useMemo(
    () => (hydrated ? overviewFor(queryClient, workspaceId) : undefined),
    [hydrated, queryClient, workspaceId],
  );
  const live = useLiveQuery({
    queryKey: ["task-overview", workspaceId, Boolean(overview)],
    query: (q) => (overview ? q.from({ task: overview.tasks }) : undefined),
  });
  // The rows in the order the server sent them (the cache's), which a live query does not keep.
  const position = useMemo(
    () => new Map(cache.tasks.map((task, index) => [task.messageId, index])),
    [cache.tasks],
  );
  const liveRows = live.isReady ? live.data : undefined;
  // Until the live query is ready (the first tick after hydration) the cache holds the same rows.
  const tasks: readonly OverviewTaskRow[] = useMemo(
    () =>
      liveRows
        ? [...liveRows].sort(
            (left, right) =>
              (position.get(left.messageId) ?? Infinity) -
              (position.get(right.messageId) ?? Infinity),
          )
        : cache.tasks,
    [liveRows, position, cache.tasks],
  );
  return useMemo(
    () => ({
      tasks,
      /** Undefined until hydrated: the server render offers no commands. */
      run: overview?.run,
      refetch: () =>
        queryClient.invalidateQueries({ queryKey: taskOverviewQuery(workspaceId).queryKey }),
    }),
    [tasks, overview, queryClient, workspaceId],
  );
}
