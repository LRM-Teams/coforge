import { describe, expect, test } from "bun:test";

import {
  agentIdFromProfileParam,
  agentProfileSearchWithoutThread,
  agentProfileParamSchema,
  agentProfileTabParamSchema,
  formatAgentProfileParam,
  resolveAgentProfileTab,
  visibleAgentProfileTabs,
  AGENT_PROFILE_TABS,
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
  test("accepts the panel's four tabs and rejects anything else", () => {
    expect(agentProfileTabParamSchema.parse("profile")).toBe("profile");
    expect(agentProfileTabParamSchema.parse("reminders")).toBe("reminders");
    expect(agentProfileTabParamSchema.parse("activity")).toBe("activity");
    expect(agentProfileTabParamSchema.parse("workspace")).toBe("workspace");
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

describe("agentProfileSearchWithoutThread", () => {
  test("removes the active thread while preserving unrelated search state", () => {
    expect(
      agentProfileSearchWithoutThread({
        view: "chat",
        threadRootId: "thread-1",
        profile: "agent:agent-1",
      }),
    ).toEqual({ view: "chat", profile: "agent:agent-1" });
  });
});

describe("visibleAgentProfileTabs", () => {
  test("shows reminders and activity to managers, workspace to the owner, profile to everyone", () => {
    expect(visibleAgentProfileTabs(false, false)).toEqual(["profile"]);
    expect(visibleAgentProfileTabs(true, false)).toEqual(["profile", "reminders", "activity"]);
    expect(visibleAgentProfileTabs(false, true)).toEqual(["profile", "workspace"]);
    expect(visibleAgentProfileTabs(true, true)).toEqual([...AGENT_PROFILE_TABS]);
  });
});

describe("resolveAgentProfileTab", () => {
  test("opens on the first tab of the viewer's order when nothing was requested", () => {
    expect(resolveAgentProfileTab(undefined, ["profile", "activity"])).toBe("profile");
    expect(resolveAgentProfileTab(undefined, ["activity", "profile"])).toBe("activity");
  });

  test("honors a requested tab the viewer can see", () => {
    expect(resolveAgentProfileTab("profile", ["activity", "profile"])).toBe("profile");
    expect(resolveAgentProfileTab("workspace", ["profile", "workspace"])).toBe("workspace");
  });

  test("falls back to the first tab when the requested one is hidden from the viewer", () => {
    expect(resolveAgentProfileTab("workspace", ["reminders", "profile"])).toBe("reminders");
    expect(resolveAgentProfileTab("activity", ["profile"])).toBe("profile");
  });
});
