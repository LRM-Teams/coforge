import { useCallback, useSyncExternalStore } from "react";

const lists = new Map<string, MediaQueryList>();

/** One `MediaQueryList` per query for the page: a message list asks the same two on every row. */
function mediaQueryList(query: string) {
  let list = lists.get(query);
  if (!list) lists.set(query, (list = window.matchMedia(query)));
  return list;
}

/**
 * Whether a media query matches. The server and the render that hydrates the server's markup use
 * `serverValue`, so the markup is the one the server sent; a browser whose query differs then
 * renders again with its own answer. A render that is not hydrating (a client navigation) reads
 * the query directly.
 * https://react.dev/reference/react/useSyncExternalStore#adding-support-for-server-rendering
 */
export function useMediaQuery(query: string, serverValue: boolean) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = mediaQueryList(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  const read = useCallback(() => mediaQueryList(query).matches, [query]);
  return useSyncExternalStore(subscribe, read, () => serverValue);
}
