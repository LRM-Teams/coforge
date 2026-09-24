import { TASK_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";
import { useCallback } from "react";

import { createDevicePreference } from "./device-preference";

/**
 * The Tasks board's hidden columns: a per-device choice, as Linear lets a board hide any column
 * from its menu and lists the hidden ones last. Every column shows by default. The choice is
 * also a class per hidden column on <html>, set by the boot script before the first paint, so a
 * hidden column never shows and then collapses while the page hydrates.
 */
const STORAGE_KEY = "coforge-task-hidden-columns";
const NONE: ReadonlySet<TaskStatus> = new Set();

/** The class on <html> naming a hidden column (see `HIDDEN_COLUMN_CLASS` in task-workflow). */
export const taskColumnHiddenClass = (status: TaskStatus) => `task-column-hidden-${status}`;

export function parseHiddenColumns(stored: string | null): ReadonlySet<TaskStatus> {
  const names = new Set(stored?.split(",") ?? []);
  return new Set(TASK_STATUSES.filter((status) => names.has(status)));
}

export function serializeHiddenColumns(hidden: ReadonlySet<TaskStatus>): string {
  return TASK_STATUSES.filter((status) => hidden.has(status)).join(",");
}

/** The boot script's part (in __root.tsx). */
export const TASK_HIDDEN_COLUMNS_BOOT = `var taskColumns=localStorage.getItem("${STORAGE_KEY}");if(taskColumns){taskColumns.split(",").forEach(function(status){if(${JSON.stringify(TASK_STATUSES)}.indexOf(status)>=0){document.documentElement.classList.add("task-column-hidden-"+status)}})}`;

const preference = createDevicePreference({
  key: STORAGE_KEY,
  parse: parseHiddenColumns,
  serialize: serializeHiddenColumns,
  fallback: NONE,
  apply: (hidden) => {
    for (const status of TASK_STATUSES)
      document.documentElement.classList.toggle(taskColumnHiddenClass(status), hidden.has(status));
  },
});

/** Whether a column is hidden now; for effects, which must not wait for a render to know. */
export const isTaskColumnHidden = (status: TaskStatus) => preference.read().has(status);

/** The hidden columns, and how to hide or show one. */
export function useTaskHiddenColumns() {
  const [hidden, setAll] = preference.useValue();
  const setHidden = useCallback(
    (status: TaskStatus, hide: boolean) => {
      const next = new Set(preference.read());
      if (hide) next.add(status);
      else next.delete(status);
      setAll(next);
    },
    [setAll],
  );
  return [hidden, setHidden] as const;
}
