import { expect, test } from "bun:test";
import { CAUSAL_TOOL_NAMES, CAUSAL_TOOL_PROFILE } from "./causal-memory";
import {
  CAUSAL_OPENVIKING_TOOL_PROFILE,
  MEMORY_AGENT_TOOL_PROFILES,
  isMemoryAgentToolProfile,
  toolsForMemoryFence,
  workspaceProfileToToolFence,
} from "./memory-tool-fences";
import { OPENVIKING_TOOL_NAMES, OPENVIKING_TOOL_PROFILE } from "./openviking-memory";

test("keeps Agent tool fences distinct from Workspace Memory Profile persistence", () => {
  expect(MEMORY_AGENT_TOOL_PROFILES).toEqual([
    "causal-memory",
    "openviking-memory",
    "causal-openviking-memory",
  ]);
  expect(OPENVIKING_TOOL_PROFILE).not.toBe("openviking");
  expect(CAUSAL_OPENVIKING_TOOL_PROFILE).not.toBe("causal_openviking");
  expect(workspaceProfileToToolFence("openviking")).toBe(OPENVIKING_TOOL_PROFILE);
  expect(workspaceProfileToToolFence("causal_openviking")).toBe(CAUSAL_OPENVIKING_TOOL_PROFILE);
  expect(workspaceProfileToToolFence("off")).toBeUndefined();
  expect(isMemoryAgentToolProfile("causal-memory")).toBe(true);
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

test("exposes causal_* plus read-only ov_* tools on the causal_openviking fence", () => {
  expect(toolsForMemoryFence(CAUSAL_OPENVIKING_TOOL_PROFILE)).toEqual([
    CAUSAL_TOOL_NAMES.search,
    CAUSAL_TOOL_NAMES.trace,
    CAUSAL_TOOL_NAMES.intervene,
    CAUSAL_TOOL_NAMES.proposeCorrection,
    CAUSAL_TOOL_NAMES.offer,
    OPENVIKING_TOOL_NAMES.find,
    OPENVIKING_TOOL_NAMES.searchContext,
    OPENVIKING_TOOL_NAMES.read,
  ]);
  expect(toolsForMemoryFence(CAUSAL_TOOL_PROFILE)).toEqual([
    CAUSAL_TOOL_NAMES.search,
    CAUSAL_TOOL_NAMES.trace,
    CAUSAL_TOOL_NAMES.intervene,
    CAUSAL_TOOL_NAMES.offer,
    CAUSAL_TOOL_NAMES.proposeCorrection,
  ]);
});
