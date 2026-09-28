import { expect, test } from "bun:test";
import { defaultCollectScanPath } from "#src/features/records/collect-scan-path";

test("a Windows computer starts at D:/", () => {
  expect(defaultCollectScanPath("win32")).toBe("D:/");
});

test("other computers keep the existing path placeholder", () => {
  expect(defaultCollectScanPath("linux")).toBe("/home/jian40/\n");
  expect(defaultCollectScanPath("darwin")).toBe("/home/jian40/\n");
  expect(defaultCollectScanPath(null)).toBe("/home/jian40/\n");
});
