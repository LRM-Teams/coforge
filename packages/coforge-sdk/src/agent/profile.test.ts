import { expect, test } from "bun:test";
import {
  decodeAgentProfileErrorResponse,
  decodeAgentProfileShowResponse,
  decodeAgentProfileUpdateResponse,
  type AgentProfileErrorResponse,
  type AgentProfileShowResponse,
} from "./profile";

const HUMAN_VALUE: AgentProfileShowResponse = {
  ok: true,
  profile: {
    kind: "human",
    id: "user-1",
    name: "alice",
    displayName: "Alice Chen",
    description: "Engineering lead.",
    role: "admin",
    isSelf: false,
    createdAgents: [{ name: "scout", displayName: "Scout", status: "online" }],
  },
};

const AGENT_VALUE: AgentProfileShowResponse = {
  ok: true,
  profile: {
    kind: "agent",
    id: "agent-1",
    name: "scout",
    displayName: "Scout",
    description: "",
    role: "member",
    isSelf: true,
    runtime: "claude-code",
    model: "sonnet",
    status: "online",
    creator: { name: "alice", displayName: "Alice Chen" },
  },
};

test("decodeAgentProfileShowResponse accepts a well-formed human profile", () => {
  expect(decodeAgentProfileShowResponse(HUMAN_VALUE)).toEqual(HUMAN_VALUE);
});

test("decodeAgentProfileShowResponse accepts a well-formed Agent profile with a null creator", () => {
  const agentProfile = AGENT_VALUE.profile;
  if (agentProfile.kind !== "agent") throw new Error("unreachable");
  const value: AgentProfileShowResponse = {
    ok: true,
    profile: { ...agentProfile, creator: null },
  };
  expect(decodeAgentProfileShowResponse(value)).toEqual(value);
});

test("decodeAgentProfileShowResponse rejects a malformed profile", () => {
  expect(() => decodeAgentProfileShowResponse(null)).toThrow();
  expect(() => decodeAgentProfileShowResponse({ ok: true, profile: { kind: "robot" } })).toThrow();
  expect(() =>
    decodeAgentProfileShowResponse({
      ok: true,
      profile: { ...HUMAN_VALUE.profile, createdAgents: [{ name: "x" }] },
    }),
  ).toThrow();
});

test("decodeAgentProfileUpdateResponse requires an agent-kind profile", () => {
  expect(decodeAgentProfileUpdateResponse(AGENT_VALUE)).toEqual(
    AGENT_VALUE as AgentProfileShowResponse & { profile: { kind: "agent" } },
  );
  expect(() => decodeAgentProfileUpdateResponse(HUMAN_VALUE)).toThrow();
});

test("decodeAgentProfileErrorResponse accepts and rejects", () => {
  const error: AgentProfileErrorResponse = {
    ok: false,
    errorCode: "profile_invalid",
    error: "displayName must not be empty.",
  };
  expect(decodeAgentProfileErrorResponse(error)).toEqual(error);
  expect(
    decodeAgentProfileErrorResponse({ ok: false, errorCode: "other", error: "x" }),
  ).toBeUndefined();
  expect(decodeAgentProfileErrorResponse(AGENT_VALUE)).toBeUndefined();
});

test("decodeAgentProfileErrorResponse accepts agent_not_visible", () => {
  const error: AgentProfileErrorResponse = {
    ok: false,
    errorCode: "agent_not_visible",
    error: "@ghost is not visible to you.",
  };
  expect(decodeAgentProfileErrorResponse(error)).toEqual(error);
});
