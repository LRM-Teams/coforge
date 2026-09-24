import { useCallback, useEffect, useState } from "react";

import {
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
 * The search page's remembered history and usage for one Workspace and viewer: read after mount
 * (the server render has no browser storage), kept in state, and written back on each change.
 */
export function useSearchMemory(workspaceId: string, userId: string) {
  const [history, setHistory] = useState<string[]>([]);
  const [usage, setUsage] = useState<SearchUsage>({});

  useEffect(() => {
    setHistory(readSearchHistory(workspaceId, userId));
    setUsage(readSearchUsage(workspaceId, userId));
  }, [workspaceId, userId]);

  const saveHistory = useCallback(
    (next: string[]) => {
      setHistory(next);
      writeSearchHistory(workspaceId, userId, next);
    },
    [workspaceId, userId],
  );

  const saveUsage = useCallback(
    (next: SearchUsage) => {
      setUsage(next);
      writeSearchUsage(workspaceId, userId, next);
    },
    [workspaceId, userId],
  );

  /** A result was opened: remember the search that found it and the place it opened. */
  const recordOpen = useCallback(
    (query: string, entity: SearchEntityKey | undefined) => {
      if (query.trim()) saveHistory(withSearch(history, query));
      if (entity) saveUsage(withOpen(usage, entity, Date.now()));
    },
    [history, usage, saveHistory, saveUsage],
  );

  const removeSearch = useCallback(
    (query: string) => saveHistory(history.filter((entry) => entry !== query)),
    [history, saveHistory],
  );

  const clearHistory = useCallback(() => saveHistory([]), [saveHistory]);

  return { history, usage, recordOpen, removeSearch, clearHistory };
}
