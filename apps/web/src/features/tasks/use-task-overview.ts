import { useCallback, useEffect, useMemo } from "react";
import { getRouteApi, useHydrated } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import {
  getUserConversationSubscriptionToken,
  getWorkspaceConversationSubscriptionToken,
} from "#src/features/realtime/realtime.functions";
import {
  createTaskOverview,
  taskOverviewQuery,
  type OverviewTaskRow,
  type TaskOverviewCollection,
} from "./task-overview-collection";
import { decodeTaskChangedEvent, type TaskChangedEvent } from "./task-realtime";

const appRoute = getRouteApi("/_app");

const selectOrder = (overview: { tasks: readonly { messageId: string }[] }) =>
  overview.tasks.map((task) => task.messageId);

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
  // The server's list of Tasks, which and in what order. Structurally shared, so it re-renders
  // only when a read changes that list, not when a change rewrites a row in the cache: after
  // hydration the rows themselves come from the collection.
  const order = useSuspenseQuery({
    ...taskOverviewQuery(workspaceId),
    select: selectOrder,
    notifyOnChangeProps: ["data"],
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
  // The rows in the order the server sent them, which a live query does not keep.
  const position = useMemo(() => new Map(order.map((id, index) => [id, index])), [order]);
  const liveRows = live.isReady ? live.data : undefined;
  const tasks: readonly OverviewTaskRow[] = useMemo(
    () =>
      liveRows
        ? [...liveRows].sort(
            (left, right) =>
              (position.get(left.messageId) ?? Infinity) -
              (position.get(right.messageId) ?? Infinity),
          )
        : // Until the live query is ready (the server render, the first tick after hydration) the
          // cache holds the same rows, already in order.
          (queryClient.getQueryData(taskOverviewQuery(workspaceId).queryKey)?.tasks ?? []),
    [liveRows, position, queryClient, workspaceId],
  );
  useTaskOverviewRealtime(overview, workspaceId);
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

/** Announcements arriving together (an Agent working through several Tasks) apply in one write. */
const APPLY_DELAY_MS = 100;

/**
 * Keeps the rows live: listens for `task.changed.v1` on the Workspace channel (channel Tasks)
 * and the viewer's own channel (direct-message Tasks), the subscriptions the nav rail already
 * holds, and applies each burst in one write. Every other publication (every chat message) is
 * dropped before any parsing beyond its type. Only a Task the page does not list yet reads the
 * list again, once per burst.
 */
function useTaskOverviewRealtime(
  overview: TaskOverviewCollection | undefined,
  workspaceId: string,
) {
  const queryClient = useQueryClient();
  const userId = appRoute.useLoaderData({ select: (data) => data.user.id });
  const getWorkspaceToken = useServerFn(getWorkspaceConversationSubscriptionToken);
  const getUserToken = useServerFn(getUserConversationSubscriptionToken);
  // One buffer per overview: a Workspace switch drops what the old one had not applied yet.
  const burst = useMemo(
    () => ({
      pending: [] as TaskChangedEvent[],
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      // Set while a read this hook asked for is in flight: its snapshot may predate them, so the
      // changes applied meanwhile are applied again once it lands.
      sinceRead: undefined as TaskChangedEvent[] | undefined,
    }),
    [overview],
  );
  useEffect(() => () => clearTimeout(burst.timer), [burst]);

  const onPublication = useCallback(
    (publication: { data: unknown }) => {
      const event = decodeTaskChangedEvent(publication.data);
      if (!event || !overview || event.workspaceId !== workspaceId) return;
      burst.pending.push(event);
      if (burst.timer !== undefined) return;
      burst.timer = setTimeout(() => {
        burst.timer = undefined;
        const events = burst.pending.splice(0);
        burst.sinceRead?.push(...events);
        let needsRead: boolean;
        try {
          needsRead = overview.apply(events);
        } catch {
          // A change that cannot be applied is shown by a read of the list instead.
          needsRead = true;
        }
        if (!needsRead || burst.sinceRead) return;
        burst.sinceRead = [];
        void queryClient
          .invalidateQueries({ queryKey: taskOverviewQuery(workspaceId).queryKey })
          .finally(() => {
            const again = burst.sinceRead ?? [];
            burst.sinceRead = undefined;
            if (again.length > 0) overview.apply(again);
          });
      }, APPLY_DELAY_MS);
    },
    [overview, workspaceId, queryClient, burst],
  );

  useRealtimeSubscription({
    channel: overview && workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    getToken: getWorkspaceToken,
    onPublication,
  });
  useRealtimeSubscription({
    channel: overview ? userConversationChannel(userId) : undefined,
    getToken: getUserToken,
    onPublication,
  });
}
