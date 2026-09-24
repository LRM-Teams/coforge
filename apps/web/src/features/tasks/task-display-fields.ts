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

// A per-device preference, like the other display settings: read from storage, shared by every
// component that shows it, and the server render (which has no storage) shows every field.
const listeners = new Set<() => void>();
let cached: { stored: string | null; fields: TaskDisplayFields } | undefined;
// Where the choice lives when storage is blocked (private mode): for this page only.
let unstored: string | null = null;

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return unstored;
  }
}

function snapshot(): TaskDisplayFields {
  const stored = readStored();
  if (cached?.stored !== stored) cached = { stored, fields: parseTaskDisplayFields(stored) };
  return cached.fields;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => event.key === STORAGE_KEY && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The fields shown, and how to show or hide one. */
export function useTaskDisplayFields() {
  const fields = useSyncExternalStore(subscribe, snapshot, () => ALL_TASK_DISPLAY_FIELDS);
  const setField = useCallback((field: TaskDisplayField, shown: boolean) => {
    const next = serializeTaskDisplayFields({ ...snapshot(), [field]: shown });
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      unstored = next;
    }
    for (const listener of listeners) listener();
  }, []);
  return [fields, setField] as const;
}
