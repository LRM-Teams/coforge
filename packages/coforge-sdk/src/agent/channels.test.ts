import { expect, test } from "bun:test";
import { decodeAgentChannelErrorResponse, type AgentChannelErrorResponse } from "./channels";

test("decodeAgentChannelErrorResponse accepts agent_not_visible", () => {
  const error: AgentChannelErrorResponse = {
    ok: false,
    errorCode: "agent_not_visible",
    error: "@ghost is not visible to you.",
  };
  expect(decodeAgentChannelErrorResponse(error)).toEqual(error);
});

test("decodeAgentChannelErrorResponse rejects an unrecognized errorCode or a success body", () => {
  expect(
    decodeAgentChannelErrorResponse({ ok: false, errorCode: "other", error: "x" }),
  ).toBeUndefined();
  expect(
    decodeAgentChannelErrorResponse({ protocolMajor: 1, idempotencyKey: "k", target: "#x" }),
  ).toBeUndefined();
  expect(decodeAgentChannelErrorResponse(undefined)).toBeUndefined();
});
