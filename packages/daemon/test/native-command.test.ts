import { expect, test } from "bun:test";
import { nativeCommandDiagnostic } from "#src/platform/native-command";

test("a failed native command keeps the explanation it printed", () => {
  expect(nativeCommandDiagnostic("Boot-out failed: 3: No such process\n")).toBe(
    "Boot-out failed: 3: No such process",
  );
  expect(nativeCommandDiagnostic("  \n\n")).toBe("");
  expect(nativeCommandDiagnostic("first\n\n  second  \nthird\nfourth\nfifth")).toBe(
    "first second third fourth",
  );
  expect(nativeCommandDiagnostic("x".repeat(600))).toHaveLength(500);
});
