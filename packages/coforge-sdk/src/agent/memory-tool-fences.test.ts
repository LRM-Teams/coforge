import { expect, test } from "bun:test";
import {
  MEMORY_AGENT_TOOL_PROFILES,
  isMemoryAgentToolProfile,
  toolsForMemoryFence,
  workspaceProfileToToolFence,
} from "./memory-tool-fences";
import { OPENVIKING_TOOL_NAMES, OPENVIKING_TOOL_PROFILE } from "./openviking-memory";

test("keeps the Agent tool fence distinct from Workspace Memory Profile persistence", () => {
  expect(MEMORY_AGENT_TOOL_PROFILES).toEqual(["openviking-memory"]);
  expect(OPENVIKING_TOOL_PROFILE).not.toBe("openviking");
  expect(workspaceProfileToToolFence("openviking")).toBe(OPENVIKING_TOOL_PROFILE);
  expect(workspaceProfileToToolFence("off")).toBeUndefined();
  expect(isMemoryAgentToolProfile(OPENVIKING_TOOL_PROFILE)).toBe(true);
  expect(isMemoryAgentToolProfile("openviking")).toBe(false);
  expect(isMemoryAgentToolProfile("all-tools")).toBe(false);
});

test("exposes only ov_* tools on the openviking fence", () => {
  expect(toolsForMemoryFence(OPENVIKING_TOOL_PROFILE)).toEqual([
    OPENVIKING_TOOL_NAMES.find,
    OPENVIKING_TOOL_NAMES.searchContext,
    OPENVIKING_TOOL_NAMES.read,
    OPENVIKING_TOOL_NAMES.offer,
  ]);
  expect(
    toolsForMemoryFence(OPENVIKING_TOOL_PROFILE).some((name) => name.startsWith("causal_")),
  ).toBe(false);
});
