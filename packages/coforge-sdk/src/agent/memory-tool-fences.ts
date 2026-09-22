/**
 * Memory Agent launch fences. These values travel on AgentStartIntent.toolProfile
 * and are intentionally distinct from Workspace Memory Profile persistence
 * (`off | openviking | causal_openviking`).
 */

import { CAUSAL_TOOL_NAMES, CAUSAL_TOOL_PROFILE } from "./causal-memory";
import { OPENVIKING_TOOL_NAMES, OPENVIKING_TOOL_PROFILE } from "./openviking-memory";

export const CAUSAL_OPENVIKING_TOOL_PROFILE = "causal-openviking-memory" as const;

export const MEMORY_AGENT_TOOL_PROFILES = [
  CAUSAL_TOOL_PROFILE,
  OPENVIKING_TOOL_PROFILE,
  CAUSAL_OPENVIKING_TOOL_PROFILE,
] as const;
export type MemoryAgentToolProfile = (typeof MEMORY_AGENT_TOOL_PROFILES)[number];

export const WORKSPACE_MEMORY_PROFILES = ["off", "openviking", "causal_openviking"] as const;
export type WorkspaceMemoryProfileName = (typeof WORKSPACE_MEMORY_PROFILES)[number];

const OPENVIKING_FENCE_TOOLS = [
  OPENVIKING_TOOL_NAMES.find,
  OPENVIKING_TOOL_NAMES.searchContext,
  OPENVIKING_TOOL_NAMES.read,
  OPENVIKING_TOOL_NAMES.offer,
] as const;

const CAUSAL_FENCE_TOOLS = [
  CAUSAL_TOOL_NAMES.search,
  CAUSAL_TOOL_NAMES.trace,
  CAUSAL_TOOL_NAMES.intervene,
  CAUSAL_TOOL_NAMES.offer,
  CAUSAL_TOOL_NAMES.proposeCorrection,
] as const;

const CAUSAL_OPENVIKING_FENCE_TOOLS = [
  CAUSAL_TOOL_NAMES.search,
  CAUSAL_TOOL_NAMES.trace,
  CAUSAL_TOOL_NAMES.intervene,
  CAUSAL_TOOL_NAMES.proposeCorrection,
  CAUSAL_TOOL_NAMES.offer,
  OPENVIKING_TOOL_NAMES.find,
  OPENVIKING_TOOL_NAMES.searchContext,
  OPENVIKING_TOOL_NAMES.read,
] as const;

export function isMemoryAgentToolProfile(value: unknown): value is MemoryAgentToolProfile {
  return (
    typeof value === "string" && (MEMORY_AGENT_TOOL_PROFILES as readonly string[]).includes(value)
  );
}

export function toolsForMemoryFence(profile: MemoryAgentToolProfile): readonly string[] {
  if (profile === OPENVIKING_TOOL_PROFILE) return OPENVIKING_FENCE_TOOLS;
  if (profile === CAUSAL_OPENVIKING_TOOL_PROFILE) return CAUSAL_OPENVIKING_FENCE_TOOLS;
  return CAUSAL_FENCE_TOOLS;
}

export function workspaceProfileToToolFence(
  profile: WorkspaceMemoryProfileName,
): MemoryAgentToolProfile | undefined {
  if (profile === "openviking") return OPENVIKING_TOOL_PROFILE;
  if (profile === "causal_openviking") return CAUSAL_OPENVIKING_TOOL_PROFILE;
  return undefined;
}
