import { expect, test } from "bun:test";

import { scaleImageZoom, stepReportPage } from "#src/features/records/report-present";

test("present mode stops at the first and last template page", () => {
  expect(stepReportPage(1, 3, 1)).toBe(2);
  expect(stepReportPage(2, 3, 1)).toBe(2);
  expect(stepReportPage(1, 3, -1)).toBe(0);
  expect(stepReportPage(0, 3, -1)).toBe(0);
});

test("an opened report image zooms between half and four times", () => {
  expect(scaleImageZoom(1, "in")).toBe(1.25);
  expect(scaleImageZoom(1, "out")).toBe(0.8);
  expect(scaleImageZoom(4, "in")).toBe(4);
  expect(scaleImageZoom(0.5, "out")).toBe(0.5);
});
