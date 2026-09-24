import { TASK_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";
import { useCallback, useSyncExternalStore } from "react";

/**
 * The Tasks board's hidden columns: a per-device choice, as Linear lets a board hide any
 * column from its menu and lists the hidden ones last. Every column shows by default, and the
 * server render (which has no storage) shows every column.
 */
const STORAGE_KEY = "coforge-task-hidden-columns";
const NONE: ReadonlySet<TaskStatus> = new Set();

export function parseHiddenColumns(stored: string | null): ReadonlySet<TaskStatus> {
  const names = new Set(stored?.split(",") ?? []);
  return new Set(TASK_STATUSES.filter((status) => names.has(status)));
}

export function serializeHiddenColumns(hidden: ReadonlySet<TaskStatus>): string {
  return TASK_STATUSES.filter((status) => hidden.has(status)).join(",");
}

const listeners = new Set<() => void>();
let cached: { stored: string | null; hidden: ReadonlySet<TaskStatus> } | undefined;
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

function snapshot(): ReadonlySet<TaskStatus> {
  const stored = readStored();
  if (cached?.stored !== stored) cached = { stored, hidden: parseHiddenColumns(stored) };
  return cached.hidden;
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

/** The hidden columns, and how to hide or show one. */
export function useTaskHiddenColumns() {
  const hidden = useSyncExternalStore(subscribe, snapshot, () => NONE);
  const setHidden = useCallback((status: TaskStatus, hide: boolean) => {
    const next = new Set(snapshot());
    if (hide) next.add(status);
    else next.delete(status);
    const stored = serializeHiddenColumns(next);
    try {
      localStorage.setItem(STORAGE_KEY, stored);
      unstored = undefined;
    } catch {
      unstored = stored;
    }
    for (const listener of listeners) listener();
  }, []);
  return [hidden, setHidden] as const;
}
