import { TASK_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";
import { FilterLines, Sliders04 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { TaskStatusIcon } from "./task-status-icon";
import { HIDDEN_COLUMN_CLASS, statusLabel, type TaskLayout } from "./task-workflow";
import { cn } from "#src/lib/utils";

/** A card's shape while its Task loads: the number line, a title of two lines, the owner. */
export function TaskCardSkeleton({ list }: { list: boolean }) {
  if (list)
    return (
      <div aria-hidden="true" className="flex h-10 items-center gap-3 px-4">
        <Skeleton className="h-3 w-7" />
        <Skeleton className="size-4 rounded-full" />
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="ml-auto hidden h-6 w-20 rounded-full sm:block" />
        <Skeleton className="size-6 rounded-full" />
      </div>
    );
  return (
    <div aria-hidden="true" className="rounded-lg border border-secondary bg-primary p-3 shadow-xs">
      <div className="flex h-6 items-center justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="size-6 rounded-full" />
      </div>
      <Skeleton className="mt-2 h-3.5 w-11/12" />
      <Skeleton className="mt-2 h-3.5 w-3/5" />
    </div>
  );
}

// Fewer placeholders further right, as a real board usually has.
const PLACEHOLDERS: Record<TaskStatus, number> = {
  todo: 3,
  in_progress: 2,
  in_review: 2,
  done: 1,
  closed: 1,
};

/**
 * The Tasks page while it loads: its header, toolbar and every status group in place, with
 * placeholder cards, so the page keeps its shape when the Tasks arrive.
 */
export function TasksPending({ layout }: { layout?: TaskLayout }) {
  return (
    <main className="flex h-svh max-h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary">
      <PageHeader heading={m.tasks_tab()} />
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-secondary px-4 py-1.5 md:px-6">
        <Button size="sm" color="tertiary" iconLeading={FilterLines} isDisabled>
          {m.tasks_filter()}
        </Button>
        <Button size="sm" color="secondary" iconLeading={Sliders04} isDisabled>
          {m.tasks_display()}
        </Button>
      </div>
      <p role="status" className="sr-only">
        {m.tasks_loading()}
      </p>
      {layout ? (
        <PendingGroups board={layout === "board"} />
      ) : (
        // No layout asked for: the page picks the board on a wide screen and the list on a narrow
        // one, so the placeholder does too.
        <>
          <PendingGroups board className="hidden md:block" />
          <PendingGroups board={false} className="md:hidden" />
        </>
      )}
    </main>
  );
}

function PendingGroups({ board, className }: { board: boolean; className?: string }) {
  return (
    <div aria-busy="true" className={cn("min-h-0 flex-1 overflow-hidden p-4 md:p-6", className)}>
      <div
        className={
          board
            ? "flex flex-col gap-3 md:h-full md:flex-row md:items-stretch md:justify-center-safe"
            : "flex flex-col gap-4"
        }
      >
        {TASK_STATUSES.map((status) => (
          <section
            key={status}
            aria-label={statusLabel(status)}
            className={
              board
                ? // The columns the viewer hid stay hidden while loading too.
                  cn(
                    "flex min-w-0 flex-col rounded-xl bg-secondary md:max-w-80 md:min-w-60 md:flex-1",
                    HIDDEN_COLUMN_CLASS[status],
                  )
                : "min-w-0 overflow-hidden rounded-xl border border-secondary bg-primary"
            }
          >
            <div
              className={
                board
                  ? "flex h-10 items-center gap-2 px-3 text-sm font-semibold text-primary"
                  : "flex h-10 items-center gap-2 border-b border-secondary bg-secondary px-4 text-sm font-semibold text-primary"
              }
            >
              <TaskStatusIcon status={status} />
              {statusLabel(status)}
              <Skeleton className="h-3.5 w-4 bg-tertiary" />
            </div>
            <div
              className={
                board ? "flex flex-col gap-2 px-2 pb-2" : "flex flex-col divide-y divide-secondary"
              }
            >
              {Array.from({ length: PLACEHOLDERS[status] }, (_, index) => (
                <TaskCardSkeleton key={index} list={!board} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
