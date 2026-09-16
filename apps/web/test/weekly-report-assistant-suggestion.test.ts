import { expect, test } from "bun:test";
import {
  buildWeeklyReportAssistantSuggestionBody,
  parseWeeklyReportAssistantSuggestion,
  weeklyReportAssistantSuggestionDisplayBody,
  type WeeklyReportAssistantSuggestion,
} from "../src/server/records/weekly-report-assistant-suggestion.server";

test("body-edit suggestions round-trip through the assistant message envelope", () => {
  const suggestion: WeeklyReportAssistantSuggestion = {
    type: "body-edit",
    reportId: "11111111-1111-1111-1111-111111111111",
    summary: "Expand the Progress section with shipped items.",
    content: {
      tabs: {
        Progress: { markdown: "- Shipped weekly-report assistant\n" },
      },
    },
  };
  const body = buildWeeklyReportAssistantSuggestionBody({
    displayText: "I drafted an update to this week's report.",
    suggestion,
  });
  expect(weeklyReportAssistantSuggestionDisplayBody(body)).toBe(
    "I drafted an update to this week's report.",
  );
  expect(parseWeeklyReportAssistantSuggestion(body)).toEqual(suggestion);
  expect(body).not.toContain("apiKey");
});

test("highlight suggestions and send prompts parse from assistant replies", () => {
  const highlight: WeeklyReportAssistantSuggestion = {
    type: "highlight",
    cycleId: "22222222-2222-2222-2222-222222222222",
    highlightId: "33333333-3333-3333-3333-333333333333",
    summary: "Candidate highlights from submitted reports.",
    content: {
      blocks: [
        {
          id: "progress",
          heading: "一、本周进展",
          paragraphs: [],
          items: [{ text: "Shipped feature", sources: [] }],
        },
      ],
    },
    markCompleted: true,
  };
  expect(
    parseWeeklyReportAssistantSuggestion(
      buildWeeklyReportAssistantSuggestionBody({
        displayText: "Review these highlights.",
        suggestion: highlight,
      }),
    ),
  ).toEqual(highlight);

  expect(
    parseWeeklyReportAssistantSuggestion(
      buildWeeklyReportAssistantSuggestionBody({
        displayText: "Ready to send when you confirm.",
        suggestion: { type: "send-prompt", reportId: "11111111-1111-1111-1111-111111111111" },
      }),
    ),
  ).toEqual({ type: "send-prompt", reportId: "11111111-1111-1111-1111-111111111111" });
});

test("invalid or missing suggestion envelopes are ignored", () => {
  expect(parseWeeklyReportAssistantSuggestion("plain assistant reply")).toBeNull();
  expect(
    parseWeeklyReportAssistantSuggestion(
      "[weekly-report-suggestion]\n{not-json}\n[/weekly-report-suggestion]",
    ),
  ).toBeNull();
  expect(
    parseWeeklyReportAssistantSuggestion(
      buildWeeklyReportAssistantSuggestionBody({
        displayText: "bad",
        suggestion: {
          type: "body-edit",
          reportId: "not-a-uuid",
          summary: "",
          content: { tabs: {} },
        },
      }),
    ),
  ).toBeNull();
});
