import type { WeeklyReportAssistantSuggestion } from "#src/server/records/weekly-report-assistant-suggestion.server";
import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";
import { z } from "zod";

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
const DISMISSED_STORAGE_PREFIX = "coforge.weekly-report-assistant.dismissed:";
const COLLECT_RUN_STORAGE_PREFIX = "coforge.weekly-report-assistant.collect-run:";
const COLLECT_PLAN_STORAGE_PREFIX = "coforge.weekly-report-assistant.collect-plan:";
const collectPlanDraftSchema = z.object({
  windowKind: z.enum(["week", "month", "quarter", "year", "custom"]),
  optionId: z.string(),
  customStart: z.string(),
  customEnd: z.string(),
  selected: z.array(z.string()),
  pathsByComputer: z.record(z.string(), z.array(z.string())),
  configuringComputerId: z.string().nullable(),
});

export function readCollectPlanDraft(
  cardKey: string,
  storage: WeeklyReportAssistantSessionStorage | null = defaultSessionStorage(),
): z.infer<typeof collectPlanDraftSchema> | null {
  try {
    const raw = storage?.getItem(`${COLLECT_PLAN_STORAGE_PREFIX}${cardKey}`);
    if (!raw) return null;
    const parsed = collectPlanDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeCollectPlanDraft(
  cardKey: string,
  draft: z.infer<typeof collectPlanDraftSchema>,
  storage: WeeklyReportAssistantSessionStorage | null = defaultSessionStorage(),
): void {
  try {
    storage?.setItem(`${COLLECT_PLAN_STORAGE_PREFIX}${cardKey}`, JSON.stringify(draft));
  } catch {
    /* The mounted card still retains its form if storage is unavailable. */
  }
}

export function readCollectCardRunId(
  cardKey: string,
  storage: WeeklyReportAssistantSessionStorage | null = defaultSessionStorage(),
): string | null {
  try {
    const id = storage?.getItem(`${COLLECT_RUN_STORAGE_PREFIX}${cardKey}`);
    return id && RFC_UUID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function writeCollectCardRunId(
  cardKey: string,
  runId: string,
  storage: WeeklyReportAssistantSessionStorage | null = defaultSessionStorage(),
): void {
  try {
    storage?.setItem(`${COLLECT_RUN_STORAGE_PREFIX}${cardKey}`, runId);
  } catch {
    // Storage may be unavailable; the mounted card still retains its submitted run.
  }
}

export function weeklyReportAssistantSubjectKey(
  subjectType: "report" | "cycle",
  subjectId: string,
) {
  return `${subjectType}:${subjectId}`;
}

export function appliedSuggestionStorageKey(subjectKey: string) {
  return `${APPLIED_STORAGE_PREFIX}${subjectKey}`;
}

export function dismissedSuggestionStorageKey(subjectKey: string) {
  return `${DISMISSED_STORAGE_PREFIX}${subjectKey}`;
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

function readIdList(
  storageKey: string,
  storage: WeeklyReportAssistantSessionStorage | null,
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

function writeIdList(
  storageKey: string,
  ids: readonly string[],
  storage: WeeklyReportAssistantSessionStorage | null,
): void {
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify([...ids]));
  } catch {
    // Ignore quota / private-mode failures; in-memory session still works for this visit.
  }
}

/** Loads durable applied-suggestion ids for a subject (survives refresh / remount). */
export function readAppliedSuggestionIds(
  subjectKey: string,
  storage: WeeklyReportAssistantSessionStorage | null = defaultSessionStorage(),
): string[] {
  return readIdList(appliedSuggestionStorageKey(subjectKey), storage);
}

/** Persists applied-suggestion ids for a subject. */
export function writeAppliedSuggestionIds(
  subjectKey: string,
  ids: readonly string[],
  storage: WeeklyReportAssistantSessionStorage | null = defaultSessionStorage(),
): void {
  writeIdList(appliedSuggestionStorageKey(subjectKey), ids, storage);
}

/** Loads durable dismissed-suggestion ids for a subject (survives refresh / remount). */
export function readDismissedSuggestionIds(
  subjectKey: string,
  storage: WeeklyReportAssistantSessionStorage | null = defaultSessionStorage(),
): string[] {
  return readIdList(dismissedSuggestionStorageKey(subjectKey), storage);
}

/** Persists dismissed-suggestion ids for a subject. */
export function writeDismissedSuggestionIds(
  subjectKey: string,
  ids: readonly string[],
  storage: WeeklyReportAssistantSessionStorage | null = defaultSessionStorage(),
): void {
  writeIdList(dismissedSuggestionStorageKey(subjectKey), ids, storage);
}

export function createWeeklyReportAssistantSession(
  appliedSuggestionIds: string[] = [],
  dismissedSuggestionIds: string[] = [],
): WeeklyReportAssistantSession {
  return {
    messages: [],
    draft: "",
    loading: false,
    error: null,
    setupDismissed: false,
    contextManifest: null,
    pendingSuggestion: null,
    dismissedSuggestionIds,
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
        session = createWeeklyReportAssistantSession(
          readAppliedSuggestionIds(key, storage),
          readDismissedSuggestionIds(key, storage),
        );
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
    markSuggestionDismissed(key: string, messageId: string) {
      const session = this.get(key);
      const next = [...new Set([...session.dismissedSuggestionIds, messageId])];
      session.dismissedSuggestionIds = next;
      writeDismissedSuggestionIds(key, next, storage);
      return next;
    },
    clear(key: string) {
      sessions.delete(key);
    },
  };
}
