import { expect, test } from "bun:test";

import {
  HIGHLIGHT_PLAN_HEADING,
  HIGHLIGHT_PROGRESS_HEADING,
} from "@/features/records/records-content";
import {
  extractWeeklyHighlightContent,
  looksLikeGenerateHighlightsRequest,
  parseRecordAssistantPayload,
} from "@/features/records/weekly-highlight-extract";

test("looksLikeGenerateHighlightsRequest matches the design phrase", () => {
  expect(looksLikeGenerateHighlightsRequest("生成本周周报要点")).toBe(true);
  expect(looksLikeGenerateHighlightsRequest("请生成要点")).toBe(true);
  expect(looksLikeGenerateHighlightsRequest("hello")).toBe(false);
});

test("parseRecordAssistantPayload accepts offer-send", () => {
  expect(parseRecordAssistantPayload({ kind: "offer-send" })).toEqual({ kind: "offer-send" });
});

test("extractWeeklyHighlightContent groups bullets and cites the member report", () => {
  const content = extractWeeklyHighlightContent([
    {
      reportId: "rep-a",
      userId: "alice",
      displayName: "Alice",
      content: {
        tabs: {
          本周进展: { markdown: "- 完成登录\n- 修了崩溃" },
          下周计划: { markdown: "- 做支付" },
        },
      },
    },
    {
      reportId: "rep-b",
      userId: "bob",
      displayName: "Bob",
      content: {
        tabs: {
          Summary: { markdown: "写了文档" },
        },
      },
    },
  ]);

  expect(content.blocks[0]?.heading).toBe(HIGHLIGHT_PROGRESS_HEADING);
  expect(content.blocks[1]?.heading).toBe(HIGHLIGHT_PLAN_HEADING);
  expect(content.blocks[0]?.items).toEqual([
    {
      text: "完成登录",
      sources: [{ reportId: "rep-a", userId: "alice", displayName: "Alice" }],
    },
    {
      text: "修了崩溃",
      sources: [{ reportId: "rep-a", userId: "alice", displayName: "Alice" }],
    },
    {
      text: "写了文档",
      sources: [{ reportId: "rep-b", userId: "bob", displayName: "Bob" }],
    },
  ]);
  expect(content.blocks[1]?.items).toEqual([
    {
      text: "做支付",
      sources: [{ reportId: "rep-a", userId: "alice", displayName: "Alice" }],
    },
  ]);
});
