import { expect, test } from "bun:test";
import {
  collectPathLines,
  defaultCollectScanPath,
  removeCollectPathLine,
} from "#src/features/records/collect-scan-path";

test("a Windows computer starts at D:/", () => {
  expect(defaultCollectScanPath("win32")).toBe("D:/");
});

test("backspace removes an added empty path and keeps the earlier one", () => {
  const lines = collectPathLines(defaultCollectScanPath("linux"));
  expect(lines).toEqual([""]);
  expect(removeCollectPathLine([...lines, ""], 1)).toEqual([""]);
  expect(removeCollectPathLine([""], 0)).toEqual([""]);
});

test("Unix computers leave the home path to the local collector", () => {
  expect(defaultCollectScanPath("linux")).toBe("\n");
  expect(defaultCollectScanPath("darwin")).toBe("\n");
  expect(defaultCollectScanPath(null)).toBe("\n");
});
