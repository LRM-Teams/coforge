import { useCallback, useRef, useState } from "react";

/**
 * Serializes an async submit: a second call while one is in flight is dropped, and
 * `pending` mirrors the in-flight state for disabling controls. The task owns its own
 * error handling; the guard only brackets it.
 */
export function useSubmitGuard(): [
  pending: boolean,
  guard: (task: () => Promise<void>) => Promise<void>,
] {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const guard = useCallback(async (task: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await task();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);
  return [pending, guard];
}
