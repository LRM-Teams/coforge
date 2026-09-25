import { TASK_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";
import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";

import type { FinishedWindow } from "./finished-tasks";
import { filterParam, parseFilterParam, type TaskFilter } from "./task-filters";
import { useTaskLayout, type TaskLayout } from "./task-workflow";

/**
 * A conversation's Task board view in the address: one status, the layout, the owner picks
 * (comma-separated User or Agent ids, `none` for nobody) and how far back Done and Closed reach
 * (a week when absent). Routes spread it into their `validateSearch`.
 */
export const conversationTaskBoardSearchShape = {
  status: z.enum(TASK_STATUSES).optional().catch(undefined),
  layout: z.enum(["board", "list"]).optional().catch(undefined),
  owners: z.string().optional().catch(undefined),
  completed: z.enum(["month", "all"]).optional().catch(undefined),
};

/** The Tasks page's board view: a conversation's, plus the Project picks (Project ids, `none` for
 * no Project), since the page mixes Projects. */
export const taskBoardSearchShape = {
  ...conversationTaskBoardSearchShape,
  projects: z.string().optional().catch(undefined),
};

type TaskBoardSearch = z.infer<z.ZodObject<typeof taskBoardSearchShape>>;

/** A board's view as the board reads it, and how it changes it. */
export type TaskBoardView = ReturnType<typeof useTaskBoardSearch>;

/**
 * The board's view read from the address, and changes written back to it. Shared by the Tasks
 * page and both conversation routes, so it navigates relative to the current route (`to: "."`)
 * rather than through one route's typed API; each route validates the result.
 */
export function useTaskBoardSearch(search: TaskBoardSearch) {
  const router = useRouter();
  const layout = useTaskLayout(search.layout);
  const { owners, projects, status, completed } = search;
  const filter = useMemo<TaskFilter>(
    () => ({ owners: parseFilterParam(owners), projects: parseFilterParam(projects) }),
    [owners, projects],
  );
  const completedWindow: FinishedWindow = completed ?? "week";
  return useMemo(() => {
    // A status or layout is a history entry; picks and the window replace the address in place, so
    // Back leaves the board rather than undoing each pick.
    const update = (patch: TaskBoardSearch, replace: boolean) =>
      void router.navigate({
        to: ".",
        replace,
        resetScroll: false,
        search: (previous: TaskBoardSearch) => ({ ...previous, ...patch }),
      });
    return {
      status,
      layout,
      filter,
      completedWindow,
      changeStatus: (next?: TaskStatus) => update({ status: next }, false),
      changeLayout: (next: TaskLayout) => update({ layout: next }, false),
      changeFilter: (next: TaskFilter) =>
        update({ owners: filterParam(next.owners), projects: filterParam(next.projects) }, true),
      changeWindow: (next: FinishedWindow) =>
        update({ completed: next === "week" ? undefined : next }, true),
    };
  }, [router, status, layout, filter, completedWindow]);
}
