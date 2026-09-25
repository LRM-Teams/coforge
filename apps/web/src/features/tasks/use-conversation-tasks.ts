import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskCommand, TaskView } from "@lrm/coforge-sdk/internal";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { useServerFn } from "@tanstack/react-start";

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
import { decodeTaskChangedEvent } from "./task-realtime";
import { executeTask } from "./tasks.functions";
import {
  applyTaskChanges,
  createTaskChangeBurst,
  type TaskChanges,
} from "./conversation-task-changes";
import { finishedTasksScopeKey } from "./use-finished-tasks";
import { m } from "#src/paraglide/messages";

const appRoute = getRouteApi("/_app");

/** The empty list while the Tasks load: one array, so what is memoized on `tasks` keeps. */
const NO_TASKS: TaskView[] = [];

/**
 * The Tasks of one conversation: read once, then kept live by the Task write's own announcement
 * (`useConversationTasks`), with a window focus as the only safety net. There is deliberately no
 * interval: a poll re-reads a list that changes only when a Task changes, and the announcement
 * says exactly which Tasks those were.
 */
const TASKS_QUERY_STALE_TIME_MS = 5_000;

export const conversationTasksQuery = (conversationId: string) =>
  queryOptions({
    queryKey: ["conversation", "tasks", conversationId],
    queryFn: async () =>
      (
        await executeTask({
          data: { operation: "list", idempotencyKey: crypto.randomUUID(), conversationId },
        })
      ).tasks,
    // A remount or focus within a few seconds of a read does not read again; realtime writes and
    // the focus safety net are unaffected.
    staleTime: TASKS_QUERY_STALE_TIME_MS,
    refetchOnWindowFocus: true,
  });

export type ConversationTasks = ReturnType<typeof useConversationTasks>;

export function useConversationTasks(conversationId: string) {
  const queryClient = useQueryClient();
  const execute = useServerFn(executeTask);
  const query = useQuery(conversationTasksQuery(conversationId));
  const queryKey = useMemo(() => conversationTasksQuery(conversationId).queryKey, [conversationId]);
  // Kept live by `task.changed.v1` (see `task-realtime.ts`): the event carries this conversation's
  // new Task copies and the ids it deleted, so a Task change writes the cached list instead of
  // making its readers read it again. Everything else a conversation publishes — every message —
  // is dropped before any parsing beyond its type. The subscriptions are the ones the nav rail
  // already holds (the Workspace channel for channel Tasks, the viewer's own for direct messages),
  // so an open panel adds no connection of its own.
  const userId = appRoute.useLoaderData({ select: (data) => data.user.id });
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const getWorkspaceToken = useServerFn(getWorkspaceConversationSubscriptionToken);
  const getUserToken = useServerFn(getUserConversationSubscriptionToken);
  /** Writes changes into the cached list in one write, and reads the Tasks tab's Done and Closed
   * again (counted and paged by the server) only when they changed. */
  const apply = useCallback(
    (changes: readonly TaskChanges[]) => {
      let finishedChanged = false;
      queryClient.setQueryData<TaskView[]>(queryKey, (current) => {
        // Before the first read there is no list to change: the read brings every Task. Whether
        // Done or Closed changed is unknown, so their reads (if any) go again.
        if (current === undefined) {
          finishedChanged = true;
          return undefined;
        }
        const result = applyTaskChanges(current, changes);
        finishedChanged = result.finishedChanged;
        return result.tasks;
      });
      if (finishedChanged)
        void queryClient.invalidateQueries({
          queryKey: finishedTasksScopeKey({ workspaceId, conversationId }),
        });
    },
    [queryClient, queryKey, workspaceId, conversationId],
  );
  // Announcements arriving together (an Agent working through several Tasks) apply in one write,
  // as on the Tasks page. One burst per conversation and `apply`; its cleanup applies whatever is
  // still gathering, so an unmount or a re-run effect drops nothing.
  const burst = useRef<ReturnType<typeof createTaskChangeBurst>>(undefined);
  useEffect(() => {
    const current = createTaskChangeBurst(conversationId, apply);
    burst.current = current;
    return () => {
      current.flush();
      if (burst.current === current) burst.current = undefined;
    };
  }, [conversationId, apply]);
  const onTaskChanged = useCallback((publication: { data: unknown }) => {
    // A publication that is not a Task change at all; the burst drops other conversations'.
    const event = decodeTaskChangedEvent(publication.data);
    if (event) burst.current?.push(event);
  }, []);
  useRealtimeSubscription({
    channel: workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    getToken: getWorkspaceToken,
    onPublication: onTaskChanged,
  });
  useRealtimeSubscription({
    channel: userConversationChannel(userId),
    getToken: getUserToken,
    onPublication: onTaskChanged,
  });
  const [mutationError, setMutationError] = useState("");
  // A failed command keeps its error on screen through the refetch it triggers; the next
  // successful read after that clears it, as any later read would.
  const holdErrorRef = useRef(false);
  useEffect(() => {
    if (!query.isSuccess) return;
    if (holdErrorRef.current) holdErrorRef.current = false;
    else setMutationError("");
  }, [query.isSuccess, query.dataUpdatedAt]);
  useEffect(() => {
    setMutationError("");
    holdErrorRef.current = false;
  }, [conversationId]);

  const command = useCallback(
    async (
      input: Omit<TaskCommand, "idempotencyKey" | "conversationId"> & { idempotencyKey?: string },
    ) => {
      setMutationError("");
      try {
        const result = await execute({
          data: {
            ...input,
            idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
            conversationId,
          },
        });
        // A list read that started before this command must not overwrite its result.
        await queryClient.cancelQueries({ queryKey });
        const deleted =
          input.operation === "delete"
            ? (queryClient
                .getQueryData<TaskView[]>(queryKey)
                ?.filter((task) => task.number === input.number)
                .map((task) => task.messageId) ?? [])
            : [];
        // Its announcement, arriving after, then finds these copies already held and reads
        // nothing again.
        apply([{ tasks: result.tasks, deleted }]);
        return result.tasks;
      } catch (cause) {
        setMutationError(m.tasks_mutation_error());
        holdErrorRef.current = true;
        await queryClient.refetchQueries({ queryKey });
        throw cause;
      }
    },
    [execute, conversationId, queryClient, queryKey, apply],
  );

  return {
    tasks: query.data ?? NO_TASKS,
    loading: query.isPending,
    error: mutationError || (query.isError ? m.tasks_load_error() : ""),
    command,
  };
}
