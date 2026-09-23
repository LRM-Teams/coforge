import { expect, test } from "bun:test";
import {
  createWeeklyReportAssistantSessionStore,
  weeklyReportAssistantSubjectKey,
} from "#src/features/records/weekly-report-assistant-session";

test("weekly report subject keys isolate independent page sessions", () => {
  expect(weeklyReportAssistantSubjectKey("report", "report-a")).toBe("report:report-a");
  expect(weeklyReportAssistantSubjectKey("cycle", "cycle-a")).toBe("cycle:cycle-a");

  const store = createWeeklyReportAssistantSessionStore();
  const report = store.get("report:report-a");
  report.draft = "draft for report a";
  report.messages.push({
    id: "message-a",
    body: "answer a",
    author: "assistant",
    createdAt: "2026-09-18T00:00:00.000Z",
  });

  const cycle = store.get("cycle:cycle-a");
  cycle.draft = "draft for cycle a";

  expect(store.get("report:report-a")).toMatchObject({
    draft: "draft for report a",
    messages: [
      {
        id: "message-a",
        body: "answer a",
        author: "assistant",
        createdAt: "2026-09-18T00:00:00.000Z",
      },
    ],
  });
  expect(store.get("cycle:cycle-a")).toMatchObject({
    draft: "draft for cycle a",
    messages: [],
  });
});

test("session store keeps context and setup dismissal scoped to one subject", () => {
  const store = createWeeklyReportAssistantSessionStore();
  const session = store.get("report:report-a");
  session.contextManifest = {
    subjectType: "report",
    subjectId: "report-a",
    structure: ["Summary"],
    availableData: ["current_report"],
  };
  session.setupDismissed = true;

  expect(store.get("report:report-a").contextManifest).toEqual(session.contextManifest);
  expect(store.get("report:report-a").setupDismissed).toBe(true);
  expect(store.get("report:report-b").contextManifest).toBeNull();
  expect(store.get("report:report-b").setupDismissed).toBe(false);
});

test("new sessions track applied suggestions separately from dismissed", () => {
  const store = createWeeklyReportAssistantSessionStore();
  const session = store.get("report:report-a");
  expect(session.appliedSuggestionIds).toEqual([]);
  expect(session.dismissedSuggestionIds).toEqual([]);

  session.appliedSuggestionIds = ["msg-1"];
  expect(store.get("report:report-a").appliedSuggestionIds).toEqual(["msg-1"]);
  expect(store.get("report:report-b").appliedSuggestionIds).toEqual([]);
});

test("applied suggestion ids survive a new session store for the same subject", () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return memory.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      memory.set(key, value);
    },
  };

  const first = createWeeklyReportAssistantSessionStore({ storage });
  first.markSuggestionApplied("report:report-a", "msg-applied");
  expect(first.get("report:report-a").appliedSuggestionIds).toEqual(["msg-applied"]);

  const afterReload = createWeeklyReportAssistantSessionStore({ storage });
  expect(afterReload.get("report:report-a").appliedSuggestionIds).toEqual(["msg-applied"]);
  expect(afterReload.get("report:report-b").appliedSuggestionIds).toEqual([]);
});

test("dismissed suggestion ids survive refresh and freeze the card state", () => {
  const memory = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return memory.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      memory.set(key, value);
    },
  };

  const first = createWeeklyReportAssistantSessionStore({ storage });
  first.markSuggestionDismissed("report:report-a", "msg-ignored");
  expect(first.get("report:report-a").dismissedSuggestionIds).toEqual(["msg-ignored"]);

  const afterReload = createWeeklyReportAssistantSessionStore({ storage });
  expect(afterReload.get("report:report-a").dismissedSuggestionIds).toEqual(["msg-ignored"]);
  expect(afterReload.get("report:report-b").dismissedSuggestionIds).toEqual([]);
});
