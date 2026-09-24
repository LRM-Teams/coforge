/** Session recall for Records sidebar section/week expand state (leave 周报 and return without a full-open tree). */

import { currentIsoWeek } from "./records-content";

export type RecordsSidebarSectionId = "favorites" | "myReports" | "members" | "notes";

export type RecordsSidebarExpandSnapshot = {
  /** Last entry / operated section — remount opens only this block. */
  activeSection?: RecordsSidebarSectionId;
  weeks: Record<string, boolean>;
};

const STORAGE_PREFIX = "coforge-records-sidebar-expand:";
const SECTION_IDS: readonly RecordsSidebarSectionId[] = [
  "favorites",
  "myReports",
  "members",
  "notes",
];
/** Prefer member / mine over favorites when migrating older multi-open snapshots. */
const SECTION_MIGRATE_ORDER: readonly RecordsSidebarSectionId[] = [
  "members",
  "myReports",
  "favorites",
  "notes",
];

type ExpandStorage = Pick<Storage, "getItem" | "setItem">;

function storageKey(workspaceKey: string) {
  return `${STORAGE_PREFIX}${workspaceKey}`;
}

function browserSessionStorage(): ExpandStorage | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    return sessionStorage;
  } catch {
    return undefined;
  }
}

function isSectionId(value: unknown): value is RecordsSidebarSectionId {
  return typeof value === "string" && SECTION_IDS.includes(value as RecordsSidebarSectionId);
}

function migrateActiveSection(row: Record<string, unknown>): RecordsSidebarSectionId | undefined {
  if (isSectionId(row.activeSection)) return row.activeSection;
  const sectionsRaw = row.sections;
  if (!sectionsRaw || typeof sectionsRaw !== "object" || Array.isArray(sectionsRaw))
    return undefined;
  const sections = sectionsRaw as Record<string, unknown>;
  for (const id of SECTION_MIGRATE_ORDER) {
    if (sections[id] === true) return id;
  }
  return undefined;
}

/** Drop malformed storage payloads so a corrupt session does not lock the sidebar open. */
export function sanitizeRecordsSidebarExpand(
  value: unknown,
): RecordsSidebarExpandSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const activeSection = migrateActiveSection(row);
  const weeks: Record<string, boolean> = {};
  const weeksRaw = row.weeks;
  if (weeksRaw && typeof weeksRaw === "object" && !Array.isArray(weeksRaw)) {
    for (const [key, open] of Object.entries(weeksRaw)) {
      if (
        typeof key === "string" &&
        key.length > 0 &&
        key.length <= 32 &&
        typeof open === "boolean"
      )
        weeks[key] = open;
    }
  }
  if (!activeSection && Object.keys(weeks).length === 0) return undefined;
  return { ...(activeSection ? { activeSection } : {}), weeks };
}

export function rememberRecordsSidebarExpand(
  workspaceKey: string,
  snapshot: RecordsSidebarExpandSnapshot,
  storage: ExpandStorage | undefined = browserSessionStorage(),
): void {
  if (!workspaceKey || !storage) return;
  try {
    storage.setItem(storageKey(workspaceKey), JSON.stringify(snapshot));
  } catch {
    // Quota / private mode: skip quietly.
  }
}

export function recallRecordsSidebarExpand(
  workspaceKey: string,
  storage: ExpandStorage | undefined = browserSessionStorage(),
): RecordsSidebarExpandSnapshot | undefined {
  if (!workspaceKey || !storage) return undefined;
  try {
    const raw = storage.getItem(storageKey(workspaceKey));
    if (!raw) return undefined;
    return sanitizeRecordsSidebarExpand(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export type RecordsSidebarDefaultContext = {
  tab: "weekly" | "notes";
  selectedRecordId?: string;
  selectedWeekKey?: string;
  /** Last sidebar entry; when set, only this section opens. */
  activeSection?: RecordsSidebarSectionId;
  favoriteIds: readonly string[];
  myReportIds: readonly string[];
  memberWeeks: readonly {
    key: string;
    overviewReportId: string;
    submissions: readonly { id: string }[];
  }[];
  noteIds?: readonly string[];
};

function selectionInMemberWeeks(
  selectedRecordId: string | undefined,
  selectedWeekKey: string | undefined,
  memberWeeks: RecordsSidebarDefaultContext["memberWeeks"],
): boolean {
  if (selectedWeekKey && memberWeeks.some((week) => week.key === selectedWeekKey)) return true;
  if (!selectedRecordId) return false;
  return memberWeeks.some(
    (week) =>
      week.overviewReportId === selectedRecordId ||
      week.submissions.some((item) => item.id === selectedRecordId),
  );
}

/**
 * Single section to open: last entry wins; otherwise one primary home for the
 * selection (mine → members → favorites), never every section that contains it.
 */
export function primaryRecordsSection(
  context: RecordsSidebarDefaultContext,
): RecordsSidebarSectionId | undefined {
  if (context.tab === "notes") return "notes";
  if (context.activeSection && context.activeSection !== "notes") return context.activeSection;
  const selected = context.selectedRecordId;
  if (context.selectedWeekKey) return "members";
  if (selected && context.myReportIds.includes(selected)) return "myReports";
  if (selectionInMemberWeeks(selected, context.selectedWeekKey, context.memberWeeks))
    return "members";
  if (selected && context.favoriteIds.includes(selected)) return "favorites";
  return undefined;
}

/** Cold-start / remount: open only the primary (entry) section. */
export function defaultRecordsSectionOpen(
  section: RecordsSidebarSectionId,
  context: RecordsSidebarDefaultContext,
): boolean {
  return primaryRecordsSection(context) === section;
}

/**
 * Default week row openness: search hits, the selected week, or the current ISO week.
 * Explicit `expandedWeeks[key]` from the user / storage wins over this.
 */
export function defaultMemberWeekExpanded(input: {
  year: number;
  week: number;
  weekSelected: boolean;
  hasSubmissions: boolean;
  queryActive: boolean;
  now?: Date;
}): boolean {
  if (input.queryActive && input.hasSubmissions) return true;
  if (input.weekSelected) return true;
  if (!input.hasSubmissions) return false;
  const current = currentIsoWeek(input.now);
  return input.year === current.year && input.week === current.week;
}
