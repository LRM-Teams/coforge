import { describe, expect, test } from "bun:test";

import {
  agentIdFromProfileParam,
  agentProfileParamSchema,
  agentProfileTabParamSchema,
  formatAgentProfileParam,
  resolveAgentProfileTab,
} from "../src/features/agents/profile-panel/profile-panel-search";

const AGENT_ID = "a1b2c3d4-e5f6-4789-a012-3456789abcde";

describe("agentProfileParamSchema", () => {
  test("accepts a well-formed agent: token", () => {
    expect(agentProfileParamSchema.parse(formatAgentProfileParam(AGENT_ID))).toBe(
      `agent:${AGENT_ID}`,
    );
  });

  test("accepts a missing value", () => {
    expect(agentProfileParamSchema.parse(undefined)).toBeUndefined();
  });

  test("falls back to undefined for a malformed token instead of throwing", () => {
    expect(agentProfileParamSchema.parse("agent:not-a-uuid")).toBeUndefined();
    expect(agentProfileParamSchema.parse("user:" + AGENT_ID)).toBeUndefined();
    expect(agentProfileParamSchema.parse("")).toBeUndefined();
  });
});

describe("agentProfileTabParamSchema", () => {
  test("accepts the panel's three tabs and rejects anything else", () => {
    expect(agentProfileTabParamSchema.parse("profile")).toBe("profile");
    expect(agentProfileTabParamSchema.parse("reminders")).toBe("reminders");
    expect(agentProfileTabParamSchema.parse("activity")).toBe("activity");
    expect(agentProfileTabParamSchema.parse("nonsense")).toBeUndefined();
    expect(agentProfileTabParamSchema.parse(undefined)).toBeUndefined();
  });
});

describe("agentIdFromProfileParam", () => {
  test("extracts the id from a valid token", () => {
    expect(agentIdFromProfileParam(formatAgentProfileParam(AGENT_ID))).toBe(AGENT_ID);
  });

  test("returns undefined for a missing or malformed token", () => {
    expect(agentIdFromProfileParam(undefined)).toBeUndefined();
    expect(agentIdFromProfileParam("agent:nope")).toBeUndefined();
    expect(agentIdFromProfileParam(`channel:${AGENT_ID}`)).toBeUndefined();
  });
});

describe("resolveAgentProfileTab", () => {
  test("defaults to profile when nothing was requested", () => {
    expect(resolveAgentProfileTab(undefined, true)).toBe("profile");
    expect(resolveAgentProfileTab(undefined, false)).toBe("profile");
  });

  test("honors an explicit profile request regardless of permission", () => {
    expect(resolveAgentProfileTab("profile", false)).toBe("profile");
  });

  test("honors activity only when the viewer may see it", () => {
    expect(resolveAgentProfileTab("activity", true)).toBe("activity");
    expect(resolveAgentProfileTab("activity", false)).toBe("profile");
  });

  test("honors reminders only when the viewer may see it", () => {
    expect(resolveAgentProfileTab("reminders", true)).toBe("reminders");
    expect(resolveAgentProfileTab("reminders", false)).toBe("profile");
  });
});
