import { expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { buildWeeklyReportHtml } from "#src/server/records/weekly-report-html.server";
import { buildWeeklyReportPresentation } from "#src/server/records/weekly-report-presentation.server";

test("weekly report presentation keeps the checked-in PPTX package", async () => {
  const bytes = await buildWeeklyReportPresentation({
    title: "Foundation Models Weekly",
    period: "2026.09.21 ~ 2026.09.24",
    members: [{ displayName: "jianghp3", sections: { Summary: "• completed the benchmark" } }],
  });
  expect(bytes.byteLength).toBeGreaterThan(1_000_000);
  const files = unzipSync(bytes);
  const xml = Object.values(files)
    .map((file) => new TextDecoder().decode(file))
    .join("\n");
  expect(xml).toContain("Foundation Models Weekly");
  expect(xml).toContain("2026.09.21 ~ 2026.09.24");
  expect(xml).toContain("completed the benchmark");
  expect(xml).toContain("weeklySlide2");
});

test("weekly report HTML export is self-contained and escapes report content", () => {
  const html = buildWeeklyReportHtml({
    title: "W40 <summary>",
    period: "2026 W40",
    summary: `- shipped <safe>\n- reviewed the export`,
    members: [
      {
        displayName: "Alice",
        sections: { Achievements: "# Delivered\n- <script>alert(1)</script>" },
      },
    ],
  });
  expect(html).toContain("W40 &lt;summary&gt;");
  expect(html).toContain("Alice · Achievements");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("@media print");
});
