import { expect, test } from "bun:test";

import {
  alignReportContentToTemplate,
  clearReportContent,
  emptyReportContent,
  normalizeReportContent,
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
