import { expect, test } from "bun:test";

import {
  defaultMemberWeekExpanded,
  defaultRecordsSectionOpen,
  primaryRecordsSection,
  recallRecordsSidebarExpand,
  rememberRecordsSidebarExpand,
  sanitizeRecordsSidebarExpand,
} from "#src/features/records/records-sidebar-expand";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? values.get(key)! : null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

const memberWeeks = [
  {
    key: "2026-39",
    overviewReportId: "overview-39",
    submissions: [{ id: "sub-a" }, { id: "sub-b" }],
  },
  {
    key: "2026-38",
    overviewReportId: "overview-38",
    submissions: [{ id: "sub-c" }],
  },
];

test("sanitizeRecordsSidebarExpand keeps activeSection and boolean weeks", () => {
  expect(
    sanitizeRecordsSidebarExpand({
      activeSection: "members",
      weeks: { "2026-39": true, "": false, bad: "yes" },
    }),
  ).toEqual({
    activeSection: "members",
    weeks: { "2026-39": true },
  });
  expect(sanitizeRecordsSidebarExpand(null)).toBeUndefined();
  expect(sanitizeRecordsSidebarExpand({ weeks: {} })).toBeUndefined();
});

test("sanitize migrates older multi-open sections to one activeSection", () => {
  expect(
    sanitizeRecordsSidebarExpand({
      sections: { favorites: true, members: true },
      weeks: {},
    }),
  ).toEqual({ activeSection: "members", weeks: {} });
});

test("remember then recall restores expand state for that Workspace", () => {
  const storage = memoryStorage();
  rememberRecordsSidebarExpand(
    "ws-1",
    { activeSection: "members", weeks: { "2026-39": false } },
    storage,
  );
  expect(recallRecordsSidebarExpand("ws-1", storage)).toEqual({
    activeSection: "members",
    weeks: { "2026-39": false },
  });
  expect(recallRecordsSidebarExpand("ws-2", storage)).toBeUndefined();
});

test("primaryRecordsSection prefers last entry over favorite overlap", () => {
  const base = {
    tab: "weekly" as const,
    selectedRecordId: "sub-a",
    favoriteIds: ["sub-a"],
    myReportIds: [],
    memberWeeks,
  };
  expect(primaryRecordsSection({ ...base, activeSection: "members" })).toBe("members");
  expect(defaultRecordsSectionOpen("favorites", { ...base, activeSection: "members" })).toBe(false);
  expect(defaultRecordsSectionOpen("members", { ...base, activeSection: "members" })).toBe(true);
  expect(primaryRecordsSection({ ...base, activeSection: "favorites" })).toBe("favorites");
});

test("without activeSection, a favorited member report opens members only", () => {
  const context = {
    tab: "weekly" as const,
    selectedRecordId: "sub-a",
    favoriteIds: ["sub-a"],
    myReportIds: [],
    memberWeeks,
  };
  expect(primaryRecordsSection(context)).toBe("members");
  expect(defaultRecordsSectionOpen("favorites", context)).toBe(false);
  expect(defaultRecordsSectionOpen("members", context)).toBe(true);
});

test("without activeSection, mine wins over favorites for the same id", () => {
  const context = {
    tab: "weekly" as const,
    selectedRecordId: "mine-1",
    favoriteIds: ["mine-1"],
    myReportIds: ["mine-1"],
    memberWeeks,
  };
  expect(primaryRecordsSection(context)).toBe("myReports");
  expect(defaultRecordsSectionOpen("favorites", context)).toBe(false);
  expect(defaultRecordsSectionOpen("myReports", context)).toBe(true);
});

test("defaultRecordsSectionOpen on the notes tab only opens notes", () => {
  const context = {
    tab: "notes" as const,
    selectedRecordId: "note-1",
    favoriteIds: [],
    myReportIds: [],
    memberWeeks: [],
    noteIds: ["note-1"],
  };
  expect(defaultRecordsSectionOpen("notes", context)).toBe(true);
  expect(defaultRecordsSectionOpen("members", context)).toBe(false);
});

test("defaultMemberWeekExpanded opens the selected week or the current ISO week", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  expect(
    defaultMemberWeekExpanded({
      year: 2026,
      week: 39,
      weekSelected: false,
      hasSubmissions: true,
      queryActive: false,
      now,
    }),
  ).toBe(true);
  expect(
    defaultMemberWeekExpanded({
      year: 2026,
      week: 38,
      weekSelected: true,
      hasSubmissions: true,
      queryActive: false,
      now,
    }),
  ).toBe(true);
});
