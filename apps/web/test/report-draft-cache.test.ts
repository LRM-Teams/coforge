import { expect, test } from "bun:test";

import {
  clearReportDraft,
  readReportDraft,
  reportBodyCharacterCount,
  resolveReportEditorContent,
  writeReportDraft,
} from "../src/features/records/report-draft-cache";

test("resolveReportEditorContent adopts server body when the local draft is empty", () => {
  const server = {
    tabs: {
      Summary: { markdown: "## shipped\n" },
      Research: { markdown: "- note\n" },
    },
  };
  const emptyDraft = {
    tabs: {
      Summary: { markdown: "" },
      Research: { markdown: "" },
    },
  };
  expect(reportBodyCharacterCount(emptyDraft)).toBe(0);
  expect(resolveReportEditorContent({ serverContent: server, draft: emptyDraft })).toEqual({
    tabs: {
      Summary: { markdown: "## shipped\n" },
      Research: { markdown: "- note\n" },
    },
  });
  expect(
    resolveReportEditorContent({
      serverContent: server,
      draft: {
        tabs: { Summary: { markdown: "local edit" } },
      },
    }),
  ).toEqual({
    tabs: { Summary: { markdown: "local edit" } },
  });
});

test("writeReportDraft stores the applied assistant body for the open editor", () => {
  const reportId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  clearReportDraft(reportId);
  writeReportDraft(reportId, {
    tabs: { Summary: { markdown: "from assistant\n" } },
  });
  expect(readReportDraft(reportId)).toEqual({
    tabs: { Summary: { markdown: "from assistant\n" } },
  });
  clearReportDraft(reportId);
});
