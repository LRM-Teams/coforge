import { expect, test } from "bun:test";
import {
  buildWeeklyReportAssistantSuggestionBody,
  parseWeeklyReportAssistantSuggestion,
  weeklyReportAssistantSuggestionDisplayBody,
  type WeeklyReportAssistantSuggestion,
} from "@/server/records/weekly-report-assistant-suggestion.server";

test("prose that mentions the suggestion tag does not truncate the display body", () => {
  const body = [
    "明白你的疑问。区别在于这是两条不同的流程：",
    "",
    "- **正文编辑（body-edit）**：走 `[weekly-report-suggestion]` 预览卡，需要你在界面上点「Confirm」。",
    "- **全员要点**：用户侧聊应出 Insert 预览卡，不要直接 submit。",
    "",
    "要按这个方式来吗？",
  ].join("\n");
  expect(weeklyReportAssistantSuggestionDisplayBody(body)).toBe(body);
  expect(parseWeeklyReportAssistantSuggestion(body)).toBeNull();
});

test("key-point-edit suggestions round-trip through the assistant message envelope", () => {
  const suggestion: WeeklyReportAssistantSuggestion = {
    type: "key-point-edit",
    reportId: "7f83f236-78fc-4bb6-b35a-d5713be78973",
    summary: "全员要点草稿",
    markdown: "## 本周进展\n- 完成侧栏重整理确认流\n",
  };
  const body = buildWeeklyReportAssistantSuggestionBody({
    displayText: "已整理好全员要点，请确认后插入。",
    suggestion,
  });
  expect(weeklyReportAssistantSuggestionDisplayBody(body)).toBe("已整理好全员要点，请确认后插入。");
  expect(parseWeeklyReportAssistantSuggestion(body)).toEqual(suggestion);
});

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

test("send prompts parse from assistant replies; highlight suggestions are ignored", () => {
  expect(
    parseWeeklyReportAssistantSuggestion(
      buildWeeklyReportAssistantSuggestionBody({
        displayText: "Ready to send when you confirm.",
        suggestion: { type: "send-prompt", reportId: "11111111-1111-1111-1111-111111111111" },
      }),
    ),
  ).toEqual({ type: "send-prompt", reportId: "11111111-1111-1111-1111-111111111111" });

  expect(
    parseWeeklyReportAssistantSuggestion(
      [
        "Review these highlights.",
        "",
        "[weekly-report-suggestion]",
        JSON.stringify({
          type: "highlight",
          cycleId: "22222222-2222-2222-2222-222222222222",
          summary: "Candidate highlights",
          content: { blocks: [] },
        }),
        "[/weekly-report-suggestion]",
      ].join("\n"),
    ),
  ).toBeNull();
});

test("body-edit tabs accept plain markdown strings as well as {markdown} objects", () => {
  const body = [
    "Draft ready.",
    "",
    "[weekly-report-suggestion]",
    JSON.stringify({
      type: "body-edit",
      reportId: "891871b0-2bbb-4bea-ade4-821b08390cbc",
      summary: "整理为成员周报草稿",
      content: {
        tabs: {
          Summary: "## Work Summary\n- shipped collect run\n",
          Research: "- surveyed ADR 0032\n",
        },
      },
    }),
    "[/weekly-report-suggestion]",
  ].join("\n");
  expect(parseWeeklyReportAssistantSuggestion(body)).toEqual({
    type: "body-edit",
    reportId: "891871b0-2bbb-4bea-ade4-821b08390cbc",
    summary: "整理为成员周报草稿",
    content: {
      tabs: {
        Summary: { markdown: "## Work Summary\n- shipped collect run\n" },
        Research: { markdown: "- surveyed ADR 0032\n" },
      },
    },
  });
});

test("body-edit content accepts a flat tab map when Agents omit the tabs wrapper", () => {
  // Incident shape: synthesizer put Summary/Research/… directly under content.
  const body = [
    "W39 周报草稿已整理完成。",
    "",
    "[weekly-report-suggestion]",
    JSON.stringify({
      type: "body-edit",
      reportId: "e3951155-f545-4d47-aee2-172d9ca10db4",
      summary: "W39：周报与 Records 产品完善",
      content: {
        Summary: {
          markdown: "## Work Summary:\n本周围绕周报产品和跨平台运行基础设施完成两条主线。\n",
        },
        Research: { markdown: "本周采集包未记录独立的研究课题。\n" },
        Technique: { markdown: "- 采用按报告隔离的 Assistant session。\n" },
        Achievements: { markdown: "- 完成周报产品 polish。\n" },
      },
    }),
    "[/weekly-report-suggestion]",
  ].join("\n");
  expect(parseWeeklyReportAssistantSuggestion(body)).toEqual({
    type: "body-edit",
    reportId: "e3951155-f545-4d47-aee2-172d9ca10db4",
    summary: "W39：周报与 Records 产品完善",
    content: {
      tabs: {
        Summary: {
          markdown: "## Work Summary:\n本周围绕周报产品和跨平台运行基础设施完成两条主线。\n",
        },
        Research: { markdown: "本周采集包未记录独立的研究课题。\n" },
        Technique: { markdown: "- 采用按报告隔离的 Assistant session。\n" },
        Achievements: { markdown: "- 完成周报产品 polish。\n" },
      },
    },
  });
});

test("body-edit suggestions with no usable tabs are ignored", () => {
  expect(
    parseWeeklyReportAssistantSuggestion(
      buildWeeklyReportAssistantSuggestionBody({
        displayText: "nothing to insert",
        suggestion: {
          type: "body-edit",
          reportId: "e3951155-f545-4d47-aee2-172d9ca10db4",
          summary: "empty draft",
          content: { tabs: {} },
        },
      }),
    ),
  ).toBeNull();
  expect(
    parseWeeklyReportAssistantSuggestion(
      [
        "empty flat content",
        "",
        "[weekly-report-suggestion]",
        JSON.stringify({
          type: "body-edit",
          reportId: "e3951155-f545-4d47-aee2-172d9ca10db4",
          summary: "empty draft",
          content: {},
        }),
        "[/weekly-report-suggestion]",
      ].join("\n"),
    ),
  ).toBeNull();
});

test("body-edit suggestions still parse when the closing fence is omitted", () => {
  const payload = {
    type: "body-edit",
    reportId: "891871b0-2bbb-4bea-ade4-821b08390cbc",
    summary: "草稿",
    content: { tabs: { Summary: { markdown: "- item\n" } } },
  };
  const body = `请确认写入。\n\n[weekly-report-suggestion]\n${JSON.stringify(payload)}\n`;
  expect(parseWeeklyReportAssistantSuggestion(body)).toEqual({
    type: "body-edit" as const,
    reportId: "891871b0-2bbb-4bea-ade4-821b08390cbc",
    summary: "草稿",
    content: { tabs: { Summary: { markdown: "- item\n" } } },
  });
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
