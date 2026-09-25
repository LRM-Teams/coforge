import { TASK_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";
import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";

import type { FinishedWindow } from "./finished-tasks";
import { filterParam, parseFilterParam, type TaskFilter } from "./task-filters";
import { useTaskLayout, type TaskLayout } from "./task-workflow";

/**
 * A Task board's view in the address, the same on the Tasks page and a conversation's Tasks tab:
 * one status, the layout, the owner and Project picks (comma-separated User or Agent ids and
 * Project ids, `none` for nobody / no Project) and how far back Done and Closed reach (a week when
 * absent). Routes spread it into their `validateSearch`.
 */
export const taskBoardSearchShape = {
  status: z.enum(TASK_STATUSES).optional().catch(undefined),
  layout: z.enum(["board", "list"]).optional().catch(undefined),
  owners: z.string().optional().catch(undefined),
  projects: z.string().optional().catch(undefined),
  completed: z.enum(["month", "all"]).optional().catch(undefined),
};

type TaskBoardSearch = {
  status?: TaskStatus;
  layout?: TaskLayout;
  owners?: string;
  projects?: string;
  completed?: "month" | "all";
};

/** The board's view read from the address, and changes written back to it. */
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
