import { expect, test } from "bun:test";
import { getCoforgeAgentDir, getCoforgeSessionDir } from "../src/paths";

test("CoForge Agent keeps runtime state in dedicated workspace directories", () => {
  expect(getCoforgeAgentDir("/workspace/agent")).toBe("/workspace/agent/.builtin-runtime");
  expect(getCoforgeSessionDir("/workspace/agent")).toBe("/workspace/agent/.builtin-sessions");
});
