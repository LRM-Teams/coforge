import type { TaskView } from "@lrm/coforge-sdk/internal";
import type { ReactNode } from "react";

import { cn } from "#src/lib/utils";
import { Box } from "@untitledui/icons";

import { TaskOwnerAvatar } from "./task-owner";
import { TaskStatusIcon } from "./task-status-icon";
import type { TaskControls } from "./task-workflow";

/**
 * Parts the viewer hid on the Tasks page (Display → Show): the stored choice is a class on
 * <html> (`features/settings/task-display-fields.ts`), and only a card inside the overview
 * (`data-task-overview`) follows it, so other surfaces always show every part. CSS alone, so a
 * change never re-renders the cards. A separator hides with whatever it would separate from.
 */
const HIDDEN_ON_OVERVIEW = {
  number: "[.task-hide-number_[data-task-overview]_&]:hidden",
  source: "[.task-hide-source_[data-task-overview]_&]:hidden",
  project: "[.task-hide-project_[data-task-overview]_&]:hidden",
  owner: "[.task-hide-owner_[data-task-overview]_&]:hidden",
  sourceDot: "[.task-hide-number_[data-task-overview]_&]:hidden",
  // A card's top line (number, source, owner) goes once all of it is hidden.
  meta: "[.task-hide-number.task-hide-source.task-hide-owner_[data-task-overview]_&]:hidden",
};

/** Classes for the link or button a caller wraps around the title. */
export const TASK_TITLE_CLASS =
  "block w-full rounded-sm text-left outline-none hover:underline hover:decoration-fg-quaternary hover:underline-offset-2 focus-visible:ring-2 focus-visible:ring-focus-ring";

/** A source or Project as a small outlined pill, as Linear shows an issue's labels. */
function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-40 min-w-0 shrink-0 items-center gap-1 rounded-full border border-secondary px-2 text-xs text-secondary",
        className,
      )}
    >
      {children}
    </span>
  );
}

function ProjectPill({ name, className }: { name: string; className?: string }) {
  return (
    <Pill className={className}>
      <Box aria-hidden="true" className="size-3 shrink-0 text-fg-brand-secondary" />
      <span className="truncate">{name}</span>
    </Pill>
  );
}

/**
 * One task on the board (a card) or in the list (a row), laid out as Linear lays out issues. The
 * caller supplies what differs per surface: the clickable title, where the task lives, its menu
 * and any claim actions.
 */
export function TaskCard({
  task,
  renderTitle,
  source,
  project,
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
  /** The Project the task's conversation belongs to, on surfaces that mix Projects; empty when it
   * has none. */
  project?: string;
  controls: TaskControls;
  menu?: ReactNode;
  actions?: ReactNode;
  list: boolean;
}) {
  const tools = (controls.handle || menu) && (
    <div className="flex shrink-0 items-center">
      {controls.handle}
      {menu}
    </div>
  );
  if (list) {
    // One line: number, status, title, then the pills, the owner and the row's own controls.
    return (
      <article className="relative flex min-h-10 items-center gap-3 px-4 py-1.5 transition-colors hover:bg-primary_hover">
        <span
          className={cn(
            "w-9 shrink-0 text-xs text-tertiary tabular-nums",
            HIDDEN_ON_OVERVIEW.number,
          )}
        >
          #{task.number}
        </span>
        <TaskStatusIcon status={task.status} />
        <h3 className="min-w-0 flex-1 text-sm font-medium text-primary">
          {renderTitle(<span className="line-clamp-1">{task.title}</span>)}
        </h3>
        {source && (
          <Pill className={cn("hidden sm:inline-flex", HIDDEN_ON_OVERVIEW.source)}>
            <span className="truncate">{source}</span>
          </Pill>
        )}
        {project && (
          <ProjectPill
            name={project}
            className={cn("hidden sm:inline-flex", HIDDEN_ON_OVERVIEW.project)}
          />
        )}
        <span className={HIDDEN_ON_OVERVIEW.owner}>
          <TaskOwnerAvatar owner={task.owner} />
        </span>
        {actions && <div className="flex shrink-0">{actions}</div>}
        {tools}
      </article>
    );
  }
  return (
    <article className="group relative rounded-lg border border-secondary bg-primary p-3 shadow-xs transition-colors hover:border-primary">
      <div
        className={cn(
          "flex h-6 items-center justify-between gap-2 text-xs text-tertiary tabular-nums",
          HIDDEN_ON_OVERVIEW.meta,
        )}
      >
        <span className="min-w-0 truncate">
          <span className={HIDDEN_ON_OVERVIEW.number}>#{task.number}</span>
          {source && (
            <span className={HIDDEN_ON_OVERVIEW.source}>
              <span className={HIDDEN_ON_OVERVIEW.sourceDot}> · </span>
              {source}
            </span>
          )}
        </span>
        <span className={HIDDEN_ON_OVERVIEW.owner}>
          <TaskOwnerAvatar owner={task.owner} />
        </span>
      </div>
      <h3 className="mt-1 text-sm leading-snug font-medium text-primary [overflow-wrap:anywhere]">
        {renderTitle(<span className="line-clamp-3">{task.title}</span>)}
      </h3>
      {task.description && (
        <p className="mt-1 line-clamp-2 text-sm text-tertiary [overflow-wrap:anywhere]">
          {task.description}
        </p>
      )}
      {(project || actions || tools) && (
        <div
          className={cn(
            "mt-3 min-h-7 items-center justify-between gap-2",
            // With a touch pointer the tools sit at this row's end, so it keeps room for them.
            tools && "any-pointer-coarse:pr-16",
            project || actions ? "flex" : "hidden any-pointer-coarse:flex",
          )}
        >
          {project ? (
            <ProjectPill name={project} className={HIDDEN_ON_OVERVIEW.project} />
          ) : (
            <span />
          )}
          {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
        </div>
      )}
      {tools && (
        // After the title in the DOM so assistive tech names the task first. With a mouse, over
        // the top corner (the owner) while hovered or focused; with a touch pointer, always shown
        // at the bottom row's end, so the owner is never covered for good.
        <div className="absolute top-2 right-1.5 rounded-md bg-primary opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100 any-pointer-coarse:top-auto any-pointer-coarse:bottom-2.5 any-pointer-coarse:opacity-100">
          {tools}
        </div>
      )}
    </article>
  );
}
