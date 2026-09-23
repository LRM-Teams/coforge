import type { TaskView } from "@lrm/coforge-sdk/internal";
import type { ReactNode } from "react";

import { TaskOwner } from "./task-owner";
import type { TaskControls } from "./task-workflow";

/** Classes for the link or button a caller wraps around the title. */
export const TASK_TITLE_CLASS =
  "block w-full rounded-sm text-left outline-none hover:underline hover:decoration-fg-quaternary hover:underline-offset-2 focus-visible:ring-2 focus-visible:ring-focus-ring";

/**
 * One task on the board (a card) or in the list (a row). The caller supplies what differs per
 * surface: the clickable title, where the task lives, its menu and any claim actions.
 */
export function TaskCard({
  task,
  renderTitle,
  source,
  controls,
  menu,
  actions,
  list,
}: {
  task: TaskView;
  /** Wraps the title text in the surface's link or button. */
  renderTitle: (title: ReactNode) => ReactNode;
  /** The conversation the task belongs to, on surfaces that mix conversations. */
  source?: string;
  controls: TaskControls;
  menu?: ReactNode;
  actions?: ReactNode;
  list: boolean;
}) {
  const title = (
    <h3 className="text-sm leading-snug font-medium text-primary [overflow-wrap:anywhere]">
      {renderTitle(<span className={list ? "line-clamp-2" : "line-clamp-3"}>{task.title}</span>)}
    </h3>
  );
  const tools = (controls.handle || menu) && (
    <div className="flex shrink-0 items-center">
      {controls.handle}
      {menu}
    </div>
  );
  if (list) {
    return (
      <article className="relative flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-primary_hover sm:flex-row sm:items-center sm:gap-4 sm:py-2.5">
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className="min-w-8 shrink-0 text-xs font-medium text-tertiary tabular-nums">
            #{task.number}
          </span>
          <div className="min-w-0 flex-1">{title}</div>
        </div>
        <div className="flex min-w-0 items-center gap-3 sm:shrink-0 sm:gap-4">
          {source && (
            <span className="max-w-24 truncate text-xs text-tertiary sm:w-28 sm:max-w-none">
              {source}
            </span>
          )}
          <div className="min-w-0 flex-1 sm:w-36 sm:flex-none">
            <TaskOwner owner={task.owner} />
          </div>
          {actions && <div className="flex sm:w-24 sm:justify-end">{actions}</div>}
          {tools}
        </div>
      </article>
    );
  }
  return (
    <article className="group relative rounded-lg border border-secondary bg-primary p-3 shadow-xs transition-colors hover:border-primary">
      <div className="flex h-6 items-center pr-14 text-xs font-medium text-tertiary tabular-nums">
        <span className="truncate">
          #{task.number}
          {source && <span className="font-normal"> · {source}</span>}
        </span>
      </div>
      <div className="mt-1">{title}</div>
      {task.description && (
        <p className="mt-1 line-clamp-2 text-sm text-tertiary [overflow-wrap:anywhere]">
          {task.description}
        </p>
      )}
      <div className="mt-3 flex min-h-6 items-center justify-between gap-2">
        <TaskOwner owner={task.owner} />
        {actions}
      </div>
      {tools && (
        // After the title in the DOM so assistive tech names the task first. Shown on hover or
        // focus, and always wherever a touch pointer exists.
        <div className="absolute top-2.5 right-1.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(any-pointer:coarse)]:opacity-100">
          {tools}
        </div>
      )}
    </article>
  );
}
