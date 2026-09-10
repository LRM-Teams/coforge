import { expect, test } from "bun:test";

import {
  alignReportContentToTemplate,
  clearReportContent,
  currentIsoWeek,
  emptyReportContent,
  isValidTemplateName,
  memberWeekTitle,
  normalizeReportContent,
} from "@/features/records/records-content";

test("formats member week titles like the design catalog", () => {
  expect(memberWeekTitle(2026, 36)).toBe("2026 W36 工作周报");
});

test("resolves the ISO week for a fixed calendar day", () => {
  expect(currentIsoWeek(new Date("2026-09-01T12:00:00+08:00"))).toEqual({
    year: 2026,
    week: 36,
  });
  expect(currentIsoWeek(new Date("2026-09-09T12:00:00+08:00"))).toEqual({
    year: 2026,
    week: 37,
  });
});

test("validates template name budget", () => {
  expect(isValidTemplateName("设计周报")).toBe(true);
  expect(isValidTemplateName("这是一个超过十个汉字的名字啊")).toBe(false);
  expect(isValidTemplateName("")).toBe(false);
});

test("builds outline tabs from template dimensions", () => {
  expect(Object.keys(emptyReportContent().tabs)).toEqual([]);
  const content = emptyReportContent(["Summary", "Research"], ["Current Work", "Next Steps"]);
  expect(Object.keys(content.tabs)).toEqual(["Summary", "Research"]);
  expect(content.tabs.Summary?.sections.map((section) => section.title)).toEqual([
    "Current Work",
    "Next Steps",
  ]);
});

test("aligns draft content to updated template dimensions", () => {
  const previous = emptyReportContent(["Summary", "Legacy"], ["A"]);
  previous.tabs.Summary!.sections[0]!.roots[0]!.text = "kept";
  const aligned = alignReportContentToTemplate(previous, ["Summary", "Research"], ["A", "B"]);
  expect(Object.keys(aligned.tabs)).toEqual(["Summary", "Research"]);
  expect(aligned.tabs.Summary?.sections[0]?.roots[0]?.text).toBe("kept");
  expect(aligned.tabs.Research?.sections.map((section) => section.title)).toEqual(["A", "B"]);
  expect(aligned.tabs.Legacy).toBeUndefined();
});

test("normalizes outline JSON and clears text without dropping sections", () => {
  const content = normalizeReportContent({
    tabs: {
      Summary: {
        sections: [
          {
            id: "sec_1",
            key: "section_0",
            title: "Current Work",
            roots: [{ id: "root_1", text: "done item", children: [] }],
          },
        ],
      },
    },
  });
  expect(content.tabs.Summary?.sections[0]?.title).toBe("Current Work");
  expect(content.tabs.Summary?.sections[0]?.roots[0]?.text).toBe("done item");

  const cleared = clearReportContent(content);
  expect(cleared.tabs.Summary?.sections[0]?.title).toBe("Current Work");
  expect(cleared.tabs.Summary?.sections[0]?.roots).toHaveLength(1);
  expect(cleared.tabs.Summary?.sections[0]?.roots[0]?.text).toBe("");
});
