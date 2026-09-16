import type { WeeklyReportAssistantSuggestion } from "../../server/records/weekly-report-assistant-suggestion.server";

export type WeeklyReportAssistantMessage = {
  id: string;
  body: string;
  author: "user" | "assistant";
  suggestion?: WeeklyReportAssistantSuggestion | null;
};

export type WeeklyReportAssistantContextManifest = {
  subjectType: "report" | "highlight" | "cycle";
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
};

export function weeklyReportAssistantSubjectKey(
  subjectType: "report" | "highlight" | "cycle",
  subjectId: string,
) {
  return `${subjectType}:${subjectId}`;
}

export function createWeeklyReportAssistantSession(): WeeklyReportAssistantSession {
  return {
    messages: [],
    draft: "",
    loading: false,
    error: null,
    setupDismissed: false,
    contextManifest: null,
    pendingSuggestion: null,
    dismissedSuggestionIds: [],
  };
}

export function createWeeklyReportAssistantSessionStore() {
  const sessions = new Map<string, WeeklyReportAssistantSession>();
  return {
    get(key: string) {
      let session = sessions.get(key);
      if (!session) {
        session = createWeeklyReportAssistantSession();
        sessions.set(key, session);
      }
      return session;
    },
    clear(key: string) {
      sessions.delete(key);
    },
  };
}
