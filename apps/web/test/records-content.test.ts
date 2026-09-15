import { expect, test } from "bun:test";

import {
  alignReportContentToTemplate,
  applyHighlightPromptText,
  clearReportContent,
  emptyReportContent,
  isAutoSendCancelled,
  memberReportTitle,
  normalizeReportContent,
  reportContentToMarkdown,
  reportTabsEqual,
  withAssignmentUnread,
  withAutoSendCancelled,
  HIGHLIGHT_PROGRESS_HEADING,
  isHighlightGenerating,
  normalizeHighlightContent,
} from "@/features/records/records-content";

test("emptyReportContent creates named display pages", () => {
  expect(emptyReportContent(["Summary", "Research"])).toEqual({
    tabs: {
      Summary: { markdown: "" },
      Research: { markdown: "" },
    },
  });
});

test("normalizeReportContent migrates a single markdown document to Summary", () => {
  expect(normalizeReportContent({ markdown: "## Hello\n\n$body$" })).toEqual({
    tabs: { Summary: { markdown: "## Hello\n\n$body$" } },
  });
});

test("normalizeReportContent preserves independent page documents", () => {
  expect(
    normalizeReportContent({
      tabs: {
        Summary: { markdown: "Current work" },
        Research: { markdown: "Open questions" },
      },
    }),
  ).toEqual({
    tabs: {
      Summary: { markdown: "Current work" },
      Research: { markdown: "Open questions" },
    },
  });
});

test("alignReportContentToTemplate adds and removes display pages without losing matching content", () => {
  expect(
    alignReportContentToTemplate(
      { tabs: { Summary: { markdown: "keep" }, Old: { markdown: "remove" } } },
      ["Summary", "Research"],
    ),
  ).toEqual({
    tabs: { Summary: { markdown: "keep" }, Research: { markdown: "" } },
  });
});

test("clearReportContent clears every page and keeps its names", () => {
  expect(
    clearReportContent({
      tabs: { Summary: { markdown: "one" }, Research: { markdown: "two" } },
    }),
  ).toEqual({
    tabs: { Summary: { markdown: "" }, Research: { markdown: "" } },
  });
});

test("normalizeReportContent preserves assignment unread metadata", () => {
  expect(
    normalizeReportContent({
      tabs: { Summary: { markdown: "body" } },
      assignment: { unread: true },
    }),
  ).toEqual({
    tabs: { Summary: { markdown: "body" } },
    assignment: { unread: true },
  });
});

test("withAssignmentUnread toggles inbox unread without dropping pages", () => {
  expect(withAssignmentUnread({ tabs: { Summary: { markdown: "x" } } }, true)).toEqual({
    tabs: { Summary: { markdown: "x" } },
    assignment: { unread: true },
  });
  expect(
    withAssignmentUnread(
      { tabs: { Summary: { markdown: "x" } }, assignment: { unread: true } },
      false,
    ),
  ).toEqual({
    tabs: { Summary: { markdown: "x" } },
    assignment: { unread: false },
  });
});

test("memberReportTitle uses the member name, year, and week", () => {
  expect(memberReportTitle("李四", 2026, 37)).toBe("李四 2026 W37 工作周报");
});

test("reportContentToMarkdown joins tabs as headings", () => {
  expect(
    reportContentToMarkdown({
      tabs: {
        Summary: { markdown: "- a" },
        Research: { markdown: "body" },
      },
    }),
  ).toBe("# Summary\n\n- a\n\n# Research\n\nbody");
});

test("reportTabsEqual ignores assignment and schedule metadata", () => {
  expect(
    reportTabsEqual(
      { tabs: { Summary: { markdown: "a" } }, assignment: { unread: true } },
      {
        tabs: { Summary: { markdown: "a" } },
        schedule: { cancelledYear: 2026, cancelledWeek: 38 },
      },
    ),
  ).toBe(true);
  expect(
    reportTabsEqual(
      { tabs: { Summary: { markdown: "a" } } },
      { tabs: { Summary: { markdown: "b" } } },
    ),
  ).toBe(false);
});

test("withAutoSendCancelled stamps the ISO week and survives normalize", () => {
  const next = withAutoSendCancelled({ tabs: { Summary: { markdown: "body" } } }, 2026, 38);
  expect(isAutoSendCancelled(next, 2026, 38)).toBe(true);
  expect(isAutoSendCancelled(next, 2026, 37)).toBe(false);
  expect(normalizeReportContent(next).schedule).toEqual({ cancelledYear: 2026, cancelledWeek: 38 });
});

test("applyHighlightPromptText pushes the previous prompt onto history", () => {
  const first = applyHighlightPromptText(
    undefined,
    "prompt-a",
    new Date("2026-09-12T03:23:34.000Z"),
  );
  expect(first).toEqual({
    text: "prompt-a",
    updatedAt: "2026-09-12T03:23:34.000Z",
    history: [],
  });
  const second = applyHighlightPromptText(first, "prompt-b", new Date("2026-09-13T04:00:00.000Z"));
  expect(second).toEqual({
    text: "prompt-b",
    updatedAt: "2026-09-13T04:00:00.000Z",
    history: [{ text: "prompt-a", updatedAt: "2026-09-12T03:23:34.000Z" }],
  });
  expect(
    applyHighlightPromptText(second, "prompt-b", new Date("2026-09-13T05:00:00.000Z")).history,
  ).toEqual(second.history);
});

test("normalizeReportContent keeps highlightPrompt history", () => {
  expect(
    normalizeReportContent({
      tabs: { Summary: { markdown: "" } },
      highlightPrompt: {
        text: "current",
        history: [{ text: "old", updatedAt: "2026-09-12T03:23:34.000Z" }],
      },
    }).highlightPrompt,
  ).toEqual({
    text: "current",
    history: [{ text: "old", updatedAt: "2026-09-12T03:23:34.000Z" }],
  });
});

test("normalizeHighlightContent upgrades string items and keeps generating", () => {
  const content = normalizeHighlightContent({
    generating: true,
    blocks: [
      {
        id: "progress",
        heading: HIGHLIGHT_PROGRESS_HEADING,
        paragraphs: [],
        items: ["legacy line"],
      },
    ],
  });
  expect(isHighlightGenerating(content)).toBe(true);
  expect(content.blocks[0]?.items).toEqual([{ text: "legacy line", sources: [] }]);
});
