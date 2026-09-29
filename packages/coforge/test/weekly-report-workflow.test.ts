import { expect, test } from "bun:test";
import { parseArgs } from "../index";

test("weekly report discovery needs no report or cycle id", () => {
  expect(parseArgs(["weekly-report", "templates"])).toEqual({
    command: "weekly-report",
    weeklyReport: { operation: "workflow", action: { type: "templates" } },
  });
  expect(parseArgs(["weekly-report", "inbox"])).toEqual({
    command: "weekly-report",
    weeklyReport: { operation: "workflow", action: { type: "inbox" } },
  });
  expect(parseArgs(["weekly-report", "workflow", "--input", "/tmp/weekly.json"])).toEqual({
    command: "weekly-report",
    inputPath: "/tmp/weekly.json",
  });
});
