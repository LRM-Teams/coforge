import { expect, test } from "bun:test";
import {
  createWeeklyReportAssistantSessionStore,
  weeklyReportAssistantSubjectKey,
} from "../src/features/records/weekly-report-assistant-session";

test("weekly report subject keys isolate independent page sessions", () => {
  expect(weeklyReportAssistantSubjectKey("report", "report-a")).toBe("report:report-a");
  expect(weeklyReportAssistantSubjectKey("highlight", "highlight-a")).toBe("highlight:highlight-a");

  const store = createWeeklyReportAssistantSessionStore();
  const report = store.get("report:report-a");
  report.draft = "draft for report a";
  report.messages.push({ id: "message-a", body: "answer a", author: "assistant" });

  const highlight = store.get("highlight:highlight-a");
  highlight.draft = "draft for highlight a";

  expect(store.get("report:report-a")).toMatchObject({
    draft: "draft for report a",
    messages: [{ id: "message-a", body: "answer a", author: "assistant" }],
  });
  expect(store.get("highlight:highlight-a")).toMatchObject({
    draft: "draft for highlight a",
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
