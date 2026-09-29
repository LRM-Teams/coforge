import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskCommand } from "@lrm/coforge-sdk/internal";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useSelector } from "@tanstack/react-store";
import { inArray, useLiveQuery } from "@tanstack/react-db";

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
import { browserTimers, createTaskChangeBurst } from "./conversation-task-changes";
import {
  conversationTasksKey,
  createConversationTasks,
  DEMAND_GC_TIME_MS,
  type ConversationTasks,
  type TaskChanges,
} from "./conversation-tasks-collection";
import { UNFINISHED_STATUSES } from "./finished-tasks";
import { finishedTasksScopeKey } from "./use-finished-tasks";
import { m } from "#src/paraglide/messages";

const appRoute = getRouteApi("/w/$workspaceSlug");

// React access to a conversation's Tasks (`conversation-tasks-collection.ts`). Its readers never
// read anything themselves: the live queries that do are the Tasks tab's (`useUnfinishedTasks`)
// and the message stream's (`ConversationTaskDemand`), and `useConversationTasks` keeps what they
// read live.

const tasksByClient = new WeakMap<QueryClient, Map<string, ConversationTasks>>();

/** One collection (and store) per `QueryClient` and conversation, so every reader shares one. The
 * readers sit under `ThreadedConversation`, which renders only in the browser, so it is never
 * created during a server render. */
export function conversationTasksFor(queryClient: QueryClient, conversationId: string) {
  let byConversation = tasksByClient.get(queryClient);
  if (!byConversation) tasksByClient.set(queryClient, (byConversation = new Map()));
  let tasks = byConversation.get(conversationId);
  if (!tasks)
    byConversation.set(
      conversationId,
      (tasks = createConversationTasks(queryClient, conversationId)),
    );
  return tasks;
}

export function useConversationTasksCollection(conversationId: string) {
  return conversationTasksFor(useQueryClient(), conversationId);
}

/**
 * The conversation's Task `#number`, which a body's task reference names. A reader re-renders only
 * when its own Task changes: the store keeps every other Task's object as it was.
 */
export function useNumberedTask(conversationId: string, number: number | undefined) {
  const { store } = useConversationTasksCollection(conversationId);
  return useSelector(store, (held) =>
    number === undefined ? undefined : held.byNumber.get(number),
  );
}

/** The Task a message became, read as `useNumberedTask` reads one. */
export function useMessageTask(conversationId: string, messageId: string) {
  const { store } = useConversationTasksCollection(conversationId);
  return useSelector(store, (held) => held.byId.get(messageId));
}

/**
 * The Tasks tab's Tasks: reads the unfinished ones while the tab shows (one live query, whose
 * predicate is the read), and lists every Task the conversation holds in number order — a Task the
 * board showed unfinished stays held after it moves to Done, which the board keeps in place.
 */
export function useUnfinishedTasks(conversationId: string) {
  const tasks = useConversationTasksCollection(conversationId);
  const unfinished = useLiveQuery({
    query: (q) =>
      q
        .from({ task: tasks.collection })
        .where(({ task }) => inArray(task.status, UNFINISHED_STATUSES)),
    gcTime: DEMAND_GC_TIME_MS,
  });
  const byId = useSelector(tasks.store, (held) => held.byId);
  const listed = useMemo(
    () => [...byId.values()].sort((left, right) => left.number - right.number),
    [byId],
  );
  return {
    tasks: listed,
    loading: unfinished.isLoading,
    failed: unfinished.isError,
  };
}

/**
 * Writes Task changes (a command's result, announced changes) into a conversation's Tasks, and
 * reads that conversation's Done and Closed again when they changed: the server counts and pages
 * those. Returns whether they did.
 */
export function useConversationTaskWrites() {
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  return useCallback(
    (conversationId: string, changes: readonly TaskChanges[], finishedChanged = false) => {
      if (
        conversationTasksFor(queryClient, conversationId).apply(changes).finishedChanged ||
        finishedChanged
      )
        void queryClient.invalidateQueries({
          queryKey: finishedTasksScopeKey({ workspaceId, conversationId }),
        });
    },
    [queryClient, workspaceId],
  );
}

export type ConversationTaskCommands = ReturnType<typeof useConversationTasks>;

/**
 * A conversation's Task commands, and what keeps its Tasks live: `task.changed.v1` (see
 * `task-realtime.ts`) carries this conversation's new Task copies and the ids it deleted, written
 * into the collection instead of reading anything again. Everything else a conversation publishes
 * — every message — is dropped before any parsing beyond its type. The subscriptions are the ones
 * the nav rail already holds (the Workspace channel for channel Tasks, the viewer's own for direct
 * messages), so an open conversation adds no connection of its own.
 */
export function useConversationTasks(conversationId: string) {
  const queryClient = useQueryClient();
  const execute = useServerFn(executeTask);
  const tasks = useConversationTasksCollection(conversationId);
  const userId = appRoute.useLoaderData({ select: (data) => data.user.id });
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const getWorkspaceToken = useServerFn(getWorkspaceConversationSubscriptionToken);
  const getUserToken = useServerFn(getUserConversationSubscriptionToken);
  const write = useConversationTaskWrites();
  const apply = useCallback(
    (changes: readonly TaskChanges[]) => write(conversationId, changes),
    [write, conversationId],
  );
  // Announcements arriving together (an Agent working through several Tasks) apply in one write,
  // as on the Tasks page. One burst per conversation and `apply`; its cleanup applies whatever is
  // still gathering, so an unmount or a re-run effect drops nothing.
  const burst = useRef<ReturnType<typeof createTaskChangeBurst>>(undefined);
  useEffect(() => {
    const current = createTaskChangeBurst(conversationId, apply, browserTimers);
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
  const [error, setError] = useState("");
  useEffect(() => setError(""), [conversationId]);

  const command = useCallback(
    async (
      input: Omit<TaskCommand, "idempotencyKey" | "conversationId"> & { idempotencyKey?: string },
    ) => {
      setError("");
      try {
        const result = await execute({
          data: {
            ...input,
            idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
            conversationId,
          },
        });
        const deletedTask =
          input.operation === "delete" && input.number !== undefined
            ? tasks.store.state.byNumber.get(input.number)
            : undefined;
        // Its announcement, arriving after, then finds these copies already held and changes
        // nothing. A deleted Task the collection does not hold (a finished one read from a page)
        // still changed Done or Closed.
        write(
          conversationId,
          [{ tasks: result.tasks, deleted: deletedTask ? [deletedTask.messageId] : [] }],
          input.operation === "delete" && !deletedTask,
        );
        return result.tasks;
      } catch (cause) {
        setError(m.tasks_mutation_error());
        // A refusal may come from a change made elsewhere (a stale revision): every subset the page
        // shows is read again, so the next try starts from the Tasks as they are.
        void queryClient.invalidateQueries({ queryKey: conversationTasksKey(conversationId) });
        throw cause;
      }
    },
    [execute, conversationId, tasks, write, queryClient],
  );

  return { command, error };
}
