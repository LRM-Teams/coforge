import { useCallback, useEffect, useState } from "react";

import {
  isSearchMemoryKey,
  readSearchHistory,
  readSearchUsage,
  withOpen,
  withSearch,
  writeSearchHistory,
  writeSearchUsage,
  type SearchEntityKey,
  type SearchUsage,
} from "./search-memory";

/**
 * The search page's remembered history and usage for one Workspace and viewer. Storage is the
 * source of truth: every change reads it afresh before writing, so two open search tabs never
 * overwrite each other, and a change made in another tab is picked up from its `storage` event.
 * `loaded` is false until the first read after mount (the server render has no storage).
 */
export function useSearchMemory(workspaceId: string, userId: string) {
  const [memory, setMemory] = useState<{
    loaded: boolean;
    history: string[];
    usage: SearchUsage;
  }>({ loaded: false, history: [], usage: {} });

  const reload = useCallback(
    () =>
      setMemory({
        loaded: true,
        history: readSearchHistory(workspaceId, userId),
        usage: readSearchUsage(workspaceId, userId),
      }),
    [workspaceId, userId],
  );

  useEffect(() => {
    reload();
    // Other tabs write drafts and layout sizes too; only this page's lists matter here.
    const onStorage = (event: StorageEvent) => {
      if (isSearchMemoryKey(event.key, workspaceId, userId)) reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reload, workspaceId, userId]);

  const updateHistory = useCallback(
    (change: (history: string[]) => string[]) => {
      writeSearchHistory(workspaceId, userId, change(readSearchHistory(workspaceId, userId)));
      reload();
    },
    [workspaceId, userId, reload],
  );

  /** A result was opened: remember the search that found it and the place it opened. */
  const recordOpen = useCallback(
    (query: string, entity: SearchEntityKey | undefined) => {
      if (query.trim()) updateHistory((history) => withSearch(history, query));
      if (entity) {
        const usage = withOpen(readSearchUsage(workspaceId, userId), entity, Date.now());
        writeSearchUsage(workspaceId, userId, usage);
        reload();
      }
    },
    [workspaceId, userId, updateHistory, reload],
  );

  const removeSearch = useCallback(
    (query: string) => updateHistory((history) => history.filter((entry) => entry !== query)),
    [updateHistory],
  );

  const clearHistory = useCallback(() => updateHistory(() => []), [updateHistory]);

  return { ...memory, recordOpen, removeSearch, clearHistory };
}
