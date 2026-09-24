import { taskMatches, type TaskFilter } from "./task-filters";
import type { loadFinishedTaskSummary } from "./tasks.functions";

// Done and Closed on the Tasks page: counted and paged by the server (`finishedSummary`,
// `finishedPage`), apart from the unfinished Tasks the page holds in full.

export type FinishedStatus = "done" | "closed";
/** How far back the page reads finished Tasks; the `completed` search param, week when absent. */
export type FinishedWindow = "week" | "month" | "all";
export type FinishedGroup = Awaited<ReturnType<typeof loadFinishedTaskSummary>>["groups"][number];

/**
 * A finished group's rows: the Tasks the page itself holds in that status (moved there since the
 * pages were read), then the read pages. A Task appears once, and the page's own copy wins, so a
 * Task moved out of the group leaves it before the pages are read again.
 */
export function finishedRows<T extends { messageId: string; status: string }>(
  status: FinishedStatus,
  onPage: readonly T[],
  pages: readonly T[],
): T[] {
  const held = new Set(onPage.map(({ messageId }) => messageId));
  return [
    ...onPage.filter((task) => task.status === status),
    ...pages.filter((task) => !held.has(task.messageId)),
  ];
}

/** How many finished Tasks in `status` match the owner and Project picks. */
export function finishedCount(
  groups: readonly FinishedGroup[],
  status: FinishedStatus,
  filter: TaskFilter,
) {
  let count = 0;
  for (const group of groups)
    if (group.status === status && taskMatches(group, filter)) count += group.count;
  return count;
}
