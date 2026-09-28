import { useCallback, useSyncExternalStore } from "react";

/**
 * A per-device preference kept in `localStorage`: read through `useSyncExternalStore` (the server
 * render, which has no storage, uses `fallback`), shared by every component that shows it, kept
 * for the page when storage refuses a write, and followed across tabs. `apply` mirrors the value
 * onto the document (classes on <html>) when it changes, for markup that follows it by CSS.
 */
export function createDevicePreference<T>({
  key,
  parse,
  serialize,
  fallback,
  apply,
}: {
  key: string;
  parse: (stored: string | null) => T;
  serialize: (value: T) => string;
  fallback: T;
  apply?: (value: T) => void;
}) {
  const listeners = new Set<() => void>();
  let cached: { stored: string | null; value: T } | undefined;
  // The value when storage refuses it (private mode, quota): for this page only.
  let unstored: string | undefined;

  function readStored(): string | null {
    if (unstored !== undefined) return unstored;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  /** The current value, read now (for effects and handlers, which run on the client). */
  function read(): T {
    const stored = readStored();
    if (cached?.stored !== stored) cached = { stored, value: parse(stored) };
    return cached.value;
  }

  function write(value: T) {
    const stored = serialize(value);
    try {
      localStorage.setItem(key, stored);
      unstored = undefined;
    } catch {
      unstored = stored;
    }
    apply?.(value);
    for (const listener of listeners) listener();
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      apply?.(parse(event.newValue));
      listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }

  function useValue() {
    const value = useSyncExternalStore(subscribe, read, () => fallback);
    const set = useCallback((next: T) => write(next), []);
    return [value, set] as const;
  }

  return { read, write, useValue };
}
