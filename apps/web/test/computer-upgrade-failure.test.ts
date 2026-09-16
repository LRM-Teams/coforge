import { expect, test } from "bun:test";
import { describeComputerUpgradeFailure } from "../src/features/computers/upgrade-failure";

test("a reported failure shows the Computer's own reason on one line", () => {
  const line = describeComputerUpgradeFailure({
    reason: "reported",
    error: "candidate failed at <path>",
  });

  expect(line).toContain("candidate failed at <path>");
  expect(line.split("\n")).toHaveLength(1);
});

test("each inferred failure reads as its own sentence, never a bare code", () => {
  const lines = (["timeout", "publication", "evidence", "reported"] as const).map((reason) =>
    describeComputerUpgradeFailure({ reason }),
  );

  expect(new Set(lines).size).toBe(4);
  for (const line of lines) {
    expect(line.endsWith(".")).toBe(true);
    expect(line).not.toContain("_");
  }
});
