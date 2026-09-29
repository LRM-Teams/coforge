import { useLayoutEffect } from "react";
import { useCreateStore, type Store } from "@tanstack/react-store";

/**
 * A TanStack Store that follows `value`: created from the first render's value, so no reader ever
 * sees an empty store, and kept in step with it before paint. For state a component already owns
 * (props, React state) that many small readers select slices of by id.
 */
export function useSyncedStore<T>(
  // `useCreateStore` reads a function as a derived store's getter, so a value is never one.
  value: T extends (...args: never[]) => unknown ? never : T,
): Store<T> {
  const store = useCreateStore<T>(value);
  useLayoutEffect(() => {
    store.setState(() => value);
  }, [store, value]);
  return store;
}
