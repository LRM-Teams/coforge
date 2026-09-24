import { useCallback, useRef } from "react";

/**
 * A handler whose identity never changes but that always calls the latest `handler`, for event
 * callbacks handed to memoized children (message rows): a parent re-render then no longer
 * re-renders every child just because an inline handler was recreated. Only for handlers run in
 * response to events — never for render-time functions whose output depends on changing data.
 * Undefined stays undefined, so a child can still tell an absent action from a present one.
 */
export function useLatestCallback<Args extends unknown[], Result>(
  handler: ((...args: Args) => Result) | undefined,
): ((...args: Args) => Result) | undefined {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const stable = useCallback((...args: Args) => handlerRef.current!(...args), []);
  return handler ? stable : undefined;
}
