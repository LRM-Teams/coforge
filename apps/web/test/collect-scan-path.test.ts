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
  expect(lines).toEqual(["/home/jian40/"]);
  expect(removeCollectPathLine([...lines, ""], 1)).toEqual(["/home/jian40/"]);
  expect(removeCollectPathLine(["/home/jian40/"], 0)).toEqual(["/home/jian40/"]);
});

test("other computers keep the existing path placeholder", () => {
  expect(defaultCollectScanPath("linux")).toBe("/home/jian40/\n");
  expect(defaultCollectScanPath("darwin")).toBe("/home/jian40/\n");
  expect(defaultCollectScanPath(null)).toBe("/home/jian40/\n");
});
