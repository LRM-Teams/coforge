import { expect, test } from "bun:test";

import { parseRecordAssistantPayload } from "@/features/records/weekly-highlight-extract";

test("parseRecordAssistantPayload accepts offer-send", () => {
  expect(parseRecordAssistantPayload({ kind: "offer-send" })).toEqual({ kind: "offer-send" });
});

test("parseRecordAssistantPayload accepts collect-plan and collect-run", () => {
  expect(
    parseRecordAssistantPayload({
      kind: "collect-plan",
      reportId: "rep-1",
      year: 2026,
      week: 38,
    }),
  ).toEqual({
    kind: "collect-plan",
    reportId: "rep-1",
    year: 2026,
    week: 38,
  });
  expect(parseRecordAssistantPayload({ kind: "collect-run", runId: "run-1" })).toEqual({
    kind: "collect-run",
    runId: "run-1",
  });
});

test("parseRecordAssistantPayload rejects removed highlight payload kinds", () => {
  expect(parseRecordAssistantPayload({ kind: "offer-generate", members: [] })).toBeNull();
  expect(parseRecordAssistantPayload({ kind: "pick-members", members: [] })).toBeNull();
  expect(parseRecordAssistantPayload({ kind: "generating", highlightId: "hl-1" })).toBeNull();
  expect(parseRecordAssistantPayload({ kind: "generated", highlightId: "hl-1" })).toBeNull();
});
