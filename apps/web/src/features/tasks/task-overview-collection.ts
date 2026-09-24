import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { createCollection, createOptimisticAction } from "@tanstack/react-db";
import {
  queryCollectionOptions,
  UpdateOperationItemNotFoundError,
} from "@tanstack/query-db-collection";
import type { TaskCommand, TaskResult, TaskStatus, TaskView } from "@lrm/coforge-sdk/internal";

import { FINISHED_TASKS_MAX, FINISHED_TASKS_PAGE } from "./task-overview-limits";
import type { TaskChangedEvent } from "./task-realtime";
import { executeTask, loadTaskOverview } from "./tasks.functions";

// The Tasks page's rows as a TanStack DB collection over the Query key its loader fills, and the
// changes made on the page: a move shows at once, the saved Task comes back from the server.

type Overview = Awaited<ReturnType<typeof loadTaskOverview>>;
export type OverviewTaskRow = Overview["tasks"][number];

/** A Task command as the page issues it: the conversation comes from the Task. */
export type OverviewTaskCommand = Omit<TaskCommand, "idempotencyKey" | "conversationId"> & {
  number: number;
};

/** The server calls the page makes; tests pass their own. */
export type TaskOverviewApi = {
  load: (options?: FinishedDepths) => Promise<Overview>;
  execute: (command: TaskCommand) => Promise<TaskResult>;
};

export const serverTaskOverviewApi: TaskOverviewApi = {
  load: (options) => loadTaskOverview({ data: options }),
  execute: (command) => executeTask({ data: command }),
};

const taskOverviewQueryKey = (workspaceId: string) => ["task", "overview", workspaceId] as const;

/** How many finished Tasks of each status the page lists. */
type FinishedDepths = { done: number; closed: number };
type FinishedStatus = keyof FinishedDepths;

/** The depths per client and Workspace: "Show older" deepens one status, and every later read of
 * the list (whoever asks for it) keeps those depths. */
const finishedDepths = new WeakMap<QueryClient, Map<string, FinishedDepths>>();
const finishedDepth = (client: QueryClient, workspaceId: string): FinishedDepths =>
  finishedDepths.get(client)?.get(workspaceId) ?? {
    done: FINISHED_TASKS_PAGE,
    closed: FINISHED_TASKS_PAGE,
  };

export const taskOverviewQuery = (
  workspaceId: string,
  api: TaskOverviewApi = serverTaskOverviewApi,
) =>
  queryOptions({
    queryKey: taskOverviewQueryKey(workspaceId),
    queryFn: ({ client }) => api.load(finishedDepth(client, workspaceId)),
  });

/** The status a command moves its Task to, when it moves it: shown before the server answers. */
function statusAfter(command: OverviewTaskCommand): TaskStatus | undefined {
  if (command.operation === "claim") return "in_progress";
  if (command.operation === "update" && command.status !== "all") return command.status;
  return undefined;
}

export function createTaskOverview(
  queryClient: QueryClient,
  workspaceId: string,
  api: TaskOverviewApi = serverTaskOverviewApi,
) {
  // Announced changes a read may not have seen yet: a read whose snapshot was taken before a
  // change reaches the collection after it, and must not put the older copy back. The collection
  // also writes each applied change into the cached list, so a copy leaves only once a newer one
  // is listed; a deleted Task never comes back, so its id stays.
  const announced = new Map<string, TaskView>();
  const deletedTasks = new Set<string>();
  const withAnnounced = (rows: readonly OverviewTaskRow[]) =>
    rows.flatMap((row) => {
      if (deletedTasks.has(row.messageId)) return [];
      const newer = announced.get(row.messageId);
      if (!newer) return [row];
      if (newer.revision >= row.revision) return [{ ...row, ...newer }];
      announced.delete(row.messageId);
      return [row];
    });

  const tasks = createCollection(
    queryCollectionOptions({
      id: `task-overview:${workspaceId}`,
      queryKey: taskOverviewQueryKey(workspaceId),
      // The same read as `taskOverviewQuery`, at the same depth.
      queryFn: () => api.load(finishedDepth(queryClient, workspaceId)),
      queryClient,
      getKey: (row: OverviewTaskRow) => row.messageId,
      select: (overview) => withAnnounced(overview.tasks),
    }),
  );

  const save = async (row: OverviewTaskRow, command: OverviewTaskCommand) => {
    const result = await api.execute({
      ...command,
      idempotencyKey: crypto.randomUUID(),
      conversationId: row.conversationId,
    });
    // The server's copy of each Task it changed replaces the shown one; the page's own fields
    // (source, Project, the viewer's membership) stay as they are.
    for (const view of result.tasks)
      if (tasks.has(view.messageId)) {
        try {
          tasks.utils.writeUpdate({ ...view, messageId: view.messageId });
        } catch (error) {
          // The Task left the page meanwhile: the next read shows the list as it is.
          if (!(error instanceof UpdateOperationItemNotFoundError)) throw error;
        }
      }
  };

  const move = createOptimisticAction<{ row: OverviewTaskRow; command: OverviewTaskCommand }>({
    onMutate: ({ row, command }) => {
      const status = statusAfter(command);
      if (status && tasks.has(row.messageId))
        tasks.update(row.messageId, (draft) => {
          draft.status = status;
        });
    },
    mutationFn: ({ row, command }) => save(row, command),
  });

  /** Runs a command on a Task. A move shows at once; the promise settles when the server has
   * answered, rejecting when it refused (the row is back by then). A command that changes nothing
   * on screen first (assign, a move to the same status, a Task the page no longer lists) makes an
   * empty transaction, which TanStack DB never saves: it goes straight to the server. */
  const run = (row: OverviewTaskRow, command: OverviewTaskCommand) => {
    const transaction = move({ row, command });
    const saved =
      transaction.mutations.length > 0
        ? transaction.isPersisted.promise.then(() => {})
        : save(row, command);
    // A refusal may come from a change made elsewhere (a stale revision): the list is read again,
    // so the next try starts from the Task as it is.
    return saved.catch(async (error: unknown) => {
      await tasks.utils.refetch().catch(() => {});
      throw error;
    });
  };

  /**
   * Applies announced Task changes (`task.changed.v1`) to the rows on screen, in one write: each
   * newer copy replaces its row's Task fields (the page's own fields stay), each deleted Task
   * leaves. Returns true when a copy names a Task this page does not list yet (a new one), which
   * only a read of the list can add, since the page's own fields are not announced.
   */
  const apply = (events: readonly TaskChangedEvent[]) => {
    const newest = new Map<string, TaskView>();
    const deleted = new Set<string>();
    let needsRead = false;
    for (const event of events) {
      for (const view of event.tasks) {
        const known = newest.get(view.messageId);
        if (!known || view.revision > known.revision) newest.set(view.messageId, view);
      }
      for (const messageId of event.deleted) deleted.add(messageId);
    }
    const updates: TaskView[] = [];
    for (const view of newest.values()) {
      if (deleted.has(view.messageId)) continue;
      const row = tasks.get(view.messageId);
      if (!row) needsRead = true;
      else if (view.revision > row.revision) updates.push(view);
    }
    for (const view of newest.values())
      if (!deleted.has(view.messageId)) {
        announced.set(view.messageId, view);
        // A Task converted again from the message of a deleted one is back.
        deletedTasks.delete(view.messageId);
      }
    for (const messageId of deleted) {
      announced.delete(messageId);
      deletedTasks.add(messageId);
    }
    const removed = [...deleted].filter((messageId) => tasks.has(messageId));
    if (updates.length > 0 || removed.length > 0)
      tasks.utils.writeBatch(() => {
        for (const view of updates) tasks.utils.writeUpdate({ ...view });
        if (removed.length > 0) tasks.utils.writeDelete(removed);
      });
    return needsRead;
  };

  /** Whether older Done or Closed Tasks exist than those listed, and can still be listed. */
  const more = (): Record<FinishedStatus, boolean> => {
    const listed = queryClient.getQueryData<Overview>(taskOverviewQueryKey(workspaceId))?.more;
    const depth = finishedDepth(queryClient, workspaceId);
    return {
      done: Boolean(listed?.done) && depth.done < FINISHED_TASKS_MAX,
      closed: Boolean(listed?.closed) && depth.closed < FINISHED_TASKS_MAX,
    };
  };

  /** Lists the next page of older Tasks of one finished status; settles once they are read. */
  const showOlder = async (status: FinishedStatus) => {
    let depths = finishedDepths.get(queryClient);
    if (!depths) finishedDepths.set(queryClient, (depths = new Map()));
    const current = finishedDepth(queryClient, workspaceId);
    depths.set(workspaceId, {
      ...current,
      [status]: Math.min(current[status] + FINISHED_TASKS_PAGE, FINISHED_TASKS_MAX),
    });
    try {
      // Rejects when the read fails (Query swallows it otherwise), so the caller can say so.
      await tasks.utils.refetch({ throwOnError: true });
    } catch (error) {
      // Not read, so not deeper: a retry asks for the same page again.
      depths.set(workspaceId, current);
      throw error;
    }
  };

  return { tasks, run, apply, more, showOlder };
}

export type TaskOverviewCollection = ReturnType<typeof createTaskOverview>;
