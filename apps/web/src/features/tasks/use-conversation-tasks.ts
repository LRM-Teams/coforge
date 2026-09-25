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
import { finishedTasksScopeKey } from "./use-finished-tasks";
import { m } from "#src/paraglide/messages";

const appRoute = getRouteApi("/_app");

export function mergeTaskChanges(current: TaskView[], changes: TaskView[]) {
  const changed = new Map(changes.map((task) => [task.messageId, task]));
  const merged = current.map((task) => {
    const replacement = changed.get(task.messageId);
    return replacement && replacement.revision >= task.revision ? replacement : task;
  });
  const known = new Set(current.map((task) => task.messageId));
  return [...merged, ...changes.filter((task) => !known.has(task.messageId))];
}

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
  const onTaskChanged = useCallback(
    (publication: { data: unknown }) => {
      const event = decodeTaskChangedEvent(publication.data);
      // Another conversation's Task, or a publication that is not a Task change at all.
      if (!event || event.conversationId !== conversationId) return;
      queryClient.setQueryData<TaskView[]>(["conversation", "tasks", conversationId], (current) =>
        mergeTaskChanges(
          (current ?? NO_TASKS).filter((task) => !event.deleted.includes(task.messageId)),
          event.tasks,
        ),
      );
      // The Tasks tab's Done and Closed are counted and paged by the server: a change may move a
      // Task into or out of them.
      void queryClient.invalidateQueries({
        queryKey: finishedTasksScopeKey({ workspaceId: event.workspaceId, conversationId }),
      });
    },
    [conversationId, queryClient],
  );
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
        queryClient.setQueryData<TaskView[]>(queryKey, (current = []) =>
          input.operation === "delete" && input.number
            ? current.filter((task) => task.number !== input.number)
            : mergeTaskChanges(current, result.tasks),
        );
        return result.tasks;
      } catch (cause) {
        setMutationError(m.tasks_mutation_error());
        holdErrorRef.current = true;
        await queryClient.refetchQueries({ queryKey });
        throw cause;
      }
    },
    [execute, conversationId, queryClient, queryKey],
  );

  return {
    tasks: query.data ?? NO_TASKS,
    loading: query.isPending,
    error: mutationError || (query.isError ? m.tasks_load_error() : ""),
    command,
  };
}
