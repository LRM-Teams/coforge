import { useCallback, useRef, useState, type RefObject } from "react";

/**
 * State that is also readable synchronously through a ref, for values that both drive
 * rendering and are consulted inside effects, scroll handlers or async continuations
 * where the latest committed value would be stale.
 */
export function useStateWithRef<T>(
  initial: T,
): [value: T, ref: RefObject<T>, set: (value: T) => void] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  return [value, ref, set];
}
