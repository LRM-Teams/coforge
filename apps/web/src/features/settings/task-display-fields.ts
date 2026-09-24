import { useCallback, useSyncExternalStore } from "react";

/** The parts of a Task the Tasks page can show besides its title and status. */
export const TASK_DISPLAY_FIELDS = ["number", "source", "project", "owner"] as const;
export type TaskDisplayField = (typeof TASK_DISPLAY_FIELDS)[number];
export type TaskDisplayFields = Readonly<Record<TaskDisplayField, boolean>>;

export const ALL_TASK_DISPLAY_FIELDS: TaskDisplayFields = {
  number: true,
  source: true,
  project: true,
  owner: true,
};

const STORAGE_KEY = "coforge-task-display-fields";

/** The class on <html> that hides a field on the Tasks page (see `taskFieldClass`). */
export const taskFieldHiddenClass = (field: TaskDisplayField) => `task-hide-${field}`;

/** Stored as the hidden fields, comma-separated, so a field added later shows by default. */
export function parseTaskDisplayFields(stored: string | null): TaskDisplayFields {
  const hidden = new Set(stored?.split(",") ?? []);
  return Object.fromEntries(
    TASK_DISPLAY_FIELDS.map((field) => [field, !hidden.has(field)]),
  ) as Record<TaskDisplayField, boolean>;
}

export function serializeTaskDisplayFields(fields: TaskDisplayFields): string {
  return TASK_DISPLAY_FIELDS.filter((field) => !fields[field]).join(",");
}

/** The boot script's part (in __root.tsx): the stored hidden fields' classes on <html>, before
 * the first paint, so the server markup (every field) never shows a field then hides it. */
export const TASK_DISPLAY_FIELDS_BOOT = `var taskHidden=localStorage.getItem("${STORAGE_KEY}");if(taskHidden){taskHidden.split(",").forEach(function(field){if(["number","source","project","owner"].indexOf(field)>=0){document.documentElement.classList.add("task-hide-"+field)}})}`;

// Per-device preference, applied as classes on <html> so cards follow by CSS alone: toggling a
// field re-renders only the Display menu, never the cards. The menu reads the choice from here.
const listeners = new Set<() => void>();
let cached: { stored: string | null; fields: TaskDisplayFields } | undefined;
// The choice when storage refuses it (private mode, quota): for this page only.
let unstored: string | undefined;

function readStored(): string | null {
  if (unstored !== undefined) return unstored;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function snapshot(): TaskDisplayFields {
  const stored = readStored();
  if (cached?.stored !== stored) cached = { stored, fields: parseTaskDisplayFields(stored) };
  return cached.fields;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    applyClasses(parseTaskDisplayFields(event.newValue));
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function applyClasses(fields: TaskDisplayFields) {
  for (const field of TASK_DISPLAY_FIELDS)
    document.documentElement.classList.toggle(taskFieldHiddenClass(field), !fields[field]);
}

/** The fields shown, and how to show or hide one. */
export function useTaskDisplayFields() {
  const fields = useSyncExternalStore(subscribe, snapshot, () => ALL_TASK_DISPLAY_FIELDS);
  const setFields = useCallback((next: TaskDisplayFields) => {
    const stored = serializeTaskDisplayFields(next);
    try {
      localStorage.setItem(STORAGE_KEY, stored);
      unstored = undefined;
    } catch {
      unstored = stored;
    }
    applyClasses(next);
    for (const listener of listeners) listener();
  }, []);
  return [fields, setFields] as const;
}
