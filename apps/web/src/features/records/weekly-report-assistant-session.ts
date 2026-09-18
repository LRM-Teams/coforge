import type { WeeklyReportAssistantSuggestion } from "../../server/records/weekly-report-assistant-suggestion.server";

export type WeeklyReportAssistantMessage = {
  id: string;
  body: string;
  author: "user" | "assistant";
  createdAt: string;
  suggestion?: WeeklyReportAssistantSuggestion | null;
};

export type WeeklyReportAssistantContextManifest = {
  subjectType: "report" | "cycle";
  subjectId: string;
  structure: readonly string[];
  availableData: readonly string[];
  [key: string]: unknown;
};

export type WeeklyReportAssistantSession = {
  messages: WeeklyReportAssistantMessage[];
  draft: string;
  loading: boolean;
  error: string | null;
  setupDismissed: boolean;
  contextManifest: WeeklyReportAssistantContextManifest | null;
  pendingSuggestion: WeeklyReportAssistantSuggestion | null;
  dismissedSuggestionIds: string[];
  /** Suggestions the User already inserted; keep the card, disable actions. */
  appliedSuggestionIds: string[];
};

export type WeeklyReportAssistantSessionStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const APPLIED_STORAGE_PREFIX = "coforge.weekly-report-assistant.applied:";

export function weeklyReportAssistantSubjectKey(
  subjectType: "report" | "cycle",
  subjectId: string,
) {
  return `${subjectType}:${subjectId}`;
}

export function appliedSuggestionStorageKey(subjectKey: string) {
  return `${APPLIED_STORAGE_PREFIX}${subjectKey}`;
}

function defaultSessionStorage(): WeeklyReportAssistantSessionStorage | null {
  try {
    const storage = (globalThis as { localStorage?: WeeklyReportAssistantSessionStorage })
      .localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/** Loads durable applied-suggestion ids for a subject (survives refresh / remount). */
export function readAppliedSuggestionIds(
  subjectKey: string,
  storage: WeeklyReportAssistantSessionStorage | null = defaultSessionStorage(),
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(appliedSuggestionStorageKey(subjectKey));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/** Persists applied-suggestion ids for a subject. */
export function writeAppliedSuggestionIds(
  subjectKey: string,
  ids: readonly string[],
  storage: WeeklyReportAssistantSessionStorage | null = defaultSessionStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(appliedSuggestionStorageKey(subjectKey), JSON.stringify([...ids]));
  } catch {
    // Ignore quota / private-mode failures; in-memory session still works for this visit.
  }
}

export function createWeeklyReportAssistantSession(
  appliedSuggestionIds: string[] = [],
): WeeklyReportAssistantSession {
  return {
    messages: [],
    draft: "",
    loading: false,
    error: null,
    setupDismissed: false,
    contextManifest: null,
    pendingSuggestion: null,
    dismissedSuggestionIds: [],
    appliedSuggestionIds,
  };
}

export function createWeeklyReportAssistantSessionStore(options?: {
  storage?: WeeklyReportAssistantSessionStorage | null;
}) {
  const sessions = new Map<string, WeeklyReportAssistantSession>();
  const storage =
    options && "storage" in options ? (options.storage ?? null) : defaultSessionStorage();

  return {
    get(key: string) {
      let session = sessions.get(key);
      if (!session) {
        session = createWeeklyReportAssistantSession(readAppliedSuggestionIds(key, storage));
        sessions.set(key, session);
      }
      return session;
    },
    markSuggestionApplied(key: string, messageId: string) {
      const session = this.get(key);
      const next = [...new Set([...session.appliedSuggestionIds, messageId])];
      session.appliedSuggestionIds = next;
      writeAppliedSuggestionIds(key, next, storage);
      return next;
    },
    clear(key: string) {
      sessions.delete(key);
    },
  };
}
