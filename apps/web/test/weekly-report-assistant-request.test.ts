import { expect, test } from "bun:test";
import { selectWeeklyReportAssistantMessages } from "../src/server/records/weekly-report-assistant-chat.server";
import {
  buildWeeklyReportAssistantRequestBody,
  messageBelongsToWeeklyReportSubject,
  weeklyReportAssistantDisplayBody,
  weeklyReportAssistantSubjectFromBody,
} from "../src/server/records/weekly-report-assistant-request.server";
import { buildWeeklyReportAssistantSuggestionBody } from "../src/server/records/weekly-report-assistant-suggestion.server";

test("assistant request bodies carry page subject and compact manifest only", () => {
  const body = buildWeeklyReportAssistantRequestBody({
    subjectType: "report",
    subjectId: "11111111-1111-1111-1111-111111111111",
    userText: "Summarize this week's progress",
    contextManifest: {
      subjectType: "report",
      subjectId: "11111111-1111-1111-1111-111111111111",
      structure: ["Progress", "Plans"],
      availableData: ["current_report", "template"],
      contextVersion: "2026-09-16T00:00:00.000Z",
    },
  });

  expect(weeklyReportAssistantSubjectFromBody(body)).toBe(
    "report:11111111-1111-1111-1111-111111111111",
  );
  expect(weeklyReportAssistantDisplayBody(body)).toBe("Summarize this week's progress");
  expect(body).toContain('"structure":["Progress","Plans"]');
  expect(body).not.toContain("private report paragraph");
  expect(
    messageBelongsToWeeklyReportSubject(body, "report", "11111111-1111-1111-1111-111111111111"),
  ).toBe(true);
  expect(
    messageBelongsToWeeklyReportSubject(body, "highlight", "11111111-1111-1111-1111-111111111111"),
  ).toBe(false);
});

test("page-scoped message selection binds assistant replies to the latest user subject", () => {
  const reportBody = buildWeeklyReportAssistantRequestBody({
    subjectType: "report",
    subjectId: "report-a",
    userText: "Summarize report A",
    contextManifest: { subjectType: "report", subjectId: "report-a", structure: [] },
  });
  const highlightBody = buildWeeklyReportAssistantRequestBody({
    subjectType: "highlight",
    subjectId: "highlight-a",
    userText: "Summarize highlight A",
    contextManifest: { subjectType: "highlight", subjectId: "highlight-a", structure: [] },
  });
  const selected = selectWeeklyReportAssistantMessages(
    [
      {
        id: "1",
        sequence: 1,
        body: reportBody,
        senderKind: "user",
        createdAt: "2026-09-16T00:00:00.000Z",
      },
      {
        id: "2",
        sequence: 2,
        body: "Report A summary",
        senderKind: "agent",
        createdAt: "2026-09-16T00:00:01.000Z",
      },
      {
        id: "3",
        sequence: 3,
        body: highlightBody,
        senderKind: "user",
        createdAt: "2026-09-16T00:00:02.000Z",
      },
      {
        id: "4",
        sequence: 4,
        body: "Highlight A summary",
        senderKind: "agent",
        createdAt: "2026-09-16T00:00:03.000Z",
      },
    ],
    "report",
    "report-a",
  );
  expect(selected.map((message) => message.displayBody)).toEqual([
    "Summarize report A",
    "Report A summary",
  ]);
  expect(selected.map((message) => message.suggestion)).toEqual([null, null]);
});

test("assistant suggestion envelopes are stripped from display and attached for confirmation", () => {
  const reportBody = buildWeeklyReportAssistantRequestBody({
    subjectType: "report",
    subjectId: "report-a",
    userText: "Improve my progress section",
    contextManifest: { subjectType: "report", subjectId: "report-a", structure: [] },
  });
  const suggestionBody = buildWeeklyReportAssistantSuggestionBody({
    displayText: "I tightened the progress bullets.",
    suggestion: {
      type: "body-edit",
      reportId: "11111111-1111-1111-1111-111111111111",
      summary: "Tighten progress",
      content: { tabs: { Progress: { markdown: "- shipped\n" } } },
    },
  });
  const selected = selectWeeklyReportAssistantMessages(
    [
      {
        id: "1",
        sequence: 1,
        body: reportBody,
        senderKind: "user",
        createdAt: "2026-09-16T00:00:00.000Z",
      },
      {
        id: "2",
        sequence: 2,
        body: suggestionBody,
        senderKind: "agent",
        createdAt: "2026-09-16T00:00:01.000Z",
      },
    ],
    "report",
    "report-a",
  );
  expect(selected).toHaveLength(2);
  expect(selected[1]?.displayBody).toBe("I tightened the progress bullets.");
  expect(selected[1]?.suggestion).toEqual({
    type: "body-edit",
    reportId: "11111111-1111-1111-1111-111111111111",
    summary: "Tighten progress",
    content: { tabs: { Progress: { markdown: "- shipped\n" } } },
  });
});
