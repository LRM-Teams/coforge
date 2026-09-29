import { expect, test } from "bun:test";
import { unzipSync } from "fflate";
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
