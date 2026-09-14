import { expect, test } from "bun:test";

import {
  alignMarkdownToSections,
  markdownToSections,
  parseTemplateSections,
  reportContentFromSections,
  sectionsFromReportContent,
  sectionsToMarkdown,
} from "@/features/records/template-outline-sections";

test("parseTemplateSections accepts legacy string dimensions", () => {
  expect(parseTemplateSections(["Summary", "Research"])).toEqual([
    { title: "Summary", children: [] },
    { title: "Research", children: [] },
  ]);
});

test("parseTemplateSections accepts nested section objects", () => {
  expect(
    parseTemplateSections([
      { title: "Summary", children: ["Current Works", "Next Steps"] },
      { title: "Technique", children: [] },
    ]),
  ).toEqual([
    { title: "Summary", children: ["Current Works", "Next Steps"] },
    { title: "Technique", children: [] },
  ]);
});

test("sectionsToMarkdown and markdownToSections round-trip H1/H2", () => {
  const sections = [
    { title: "Summary", children: ["Current Works", "Next Steps"] },
    { title: "Technique", children: [] },
    { title: "Achievements", children: [] },
    { title: "Research", children: [] },
  ];
  const markdown = sectionsToMarkdown(sections);
  expect(markdown).toBe(
    "# Summary\n## Current Works\n## Next Steps\n# Technique\n# Achievements\n# Research",
  );
  expect(markdownToSections(markdown)).toEqual(sections);
});

test("alignMarkdownToSections keeps body under matching headings", () => {
  const existing = "# Summary\nkept-a\n## Current Works\nkept-b\n# Old\ngone";
  const next = alignMarkdownToSections(existing, [
    { title: "Summary", children: ["Current Works", "Next Steps"] },
    { title: "Technique", children: [] },
  ]);
  expect(next).toBe(
    "# Summary\nkept-a\n## Current Works\nkept-b\n## Next Steps\n# Technique",
  );
});

test("reportContentFromSections writes a Summary tab", () => {
  const content = reportContentFromSections([{ title: "Summary", children: ["A"] }]);
  expect(sectionsFromReportContent(content)).toEqual([
    { title: "Summary", children: ["A"] },
  ]);
});
