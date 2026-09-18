import { expect, test } from "bun:test";
import {
  decodeAgentUserInfoErrorResponse,
  decodeAgentUserInfoResponse,
  type AgentUserInfoErrorResponse,
  type AgentUserInfoResponse,
} from "./user-info";

const HUMAN_VALUE: AgentUserInfoResponse = {
  ok: true,
  user: {
    kind: "human",
    id: "user-1",
    name: "alice",
    displayName: "Alice Chen",
    description: "Engineering lead.",
    role: "admin",
    isSelf: false,
  },
  memberships: [{ channel: "#general", role: "member" }],
};

const AGENT_VALUE: AgentUserInfoResponse = {
  ok: true,
  user: {
    kind: "agent",
    id: "agent-1",
    name: "scout",
    displayName: "Scout",
    description: "",
    role: "member",
    isSelf: true,
    computerName: "Alice's Mac",
    runtime: "claude-code",
    model: "sonnet",
    status: "online",
  },
  memberships: [],
};

test("decodeAgentUserInfoResponse accepts a well-formed human response", () => {
  expect(decodeAgentUserInfoResponse(HUMAN_VALUE)).toEqual(HUMAN_VALUE);
});

test("decodeAgentUserInfoResponse accepts a well-formed Agent response", () => {
  expect(decodeAgentUserInfoResponse(AGENT_VALUE)).toEqual(AGENT_VALUE);
});

test("decodeAgentUserInfoResponse rejects a malformed response", () => {
  expect(() => decodeAgentUserInfoResponse(null)).toThrow();
  expect(() => decodeAgentUserInfoResponse({ ok: true })).toThrow();
  expect(() =>
    decodeAgentUserInfoResponse({
      ok: true,
      user: { ...HUMAN_VALUE.user, kind: "robot" },
      memberships: [],
    }),
  ).toThrow();
  expect(() =>
    decodeAgentUserInfoResponse({
      ok: true,
      user: HUMAN_VALUE.user,
      memberships: [{ channel: 1 }],
    }),
  ).toThrow();
});

test("decodeAgentUserInfoErrorResponse accepts and rejects", () => {
  const error: AgentUserInfoErrorResponse = {
    ok: false,
    errorCode: "user_not_found",
    error: 'No human or Agent named "x".',
  };
  expect(decodeAgentUserInfoErrorResponse(error)).toEqual(error);
  expect(
    decodeAgentUserInfoErrorResponse({ ok: false, errorCode: "other", error: "x" }),
  ).toBeUndefined();
  expect(decodeAgentUserInfoErrorResponse(HUMAN_VALUE)).toBeUndefined();
});
