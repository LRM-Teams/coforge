import { expect, test } from "bun:test";

import {
  alignReportContentToTemplate,
  clearReportContent,
  emptyReportContent,
  normalizeReportContent,
} from "@/features/records/records-content";

test("emptyReportContent is a blank markdown document", () => {
  expect(emptyReportContent()).toEqual({ markdown: "" });
});

test("normalizeReportContent keeps a single markdown document", () => {
  expect(normalizeReportContent({ markdown: "## Hello\n\n$body$" })).toEqual({
    markdown: "## Hello\n\n$body$",
  });
});

test("normalizeReportContent flattens legacy tabs and sections into one document", () => {
  const normalized = normalizeReportContent({
    tabs: {
      进展: {
        sections: [
          {
            id: "sec-1",
            key: "section_0",
            title: "工作内容",
            markdown: "完成登录",
          },
        ],
      },
      风险: {
        sections: [
          {
            id: "sec-2",
            key: "section_0",
            title: "阻塞",
            roots: [{ id: "n1", text: "缺环境", children: [] }],
          },
        ],
      },
    },
  });

  expect(normalized.markdown).toBe(
    ["# 进展", "## 工作内容", "完成登录", "# 风险", "## 阻塞", "- 缺环境"].join("\n\n"),
  );
});

test("clearReportContent clears markdown", () => {
  expect(clearReportContent({ markdown: "hello" })).toEqual({ markdown: "" });
});

test("alignReportContentToTemplate no longer reshapes the body from settings", () => {
  const content = { markdown: "keep me" };
  expect(alignReportContentToTemplate(content)).toEqual({ markdown: "keep me" });
});
