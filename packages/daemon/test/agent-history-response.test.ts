import { expect, test } from "bun:test";
import type { AgentHistoryResponse } from "@lrm/coforge-sdk/agent";
import { adaptAgentHistoryResponse } from "#src/connection/agent-http-clients";

/** A read response as the wire might carry it: `fields` may be malformed, as a server's could be. */
const response = (fields: Record<string, unknown> = {}) =>
  ({
    idempotencyKey: "read-1",
    messages: [],
    hasOlder: false,
    hasNewer: false,
    ...fields,
  }) as unknown as AgentHistoryResponse;

test("a read's boundary is the server's positive integer, and anything else is no boundary", () => {
  expect(adaptAgentHistoryResponse(response()).modelSeenUpToSeq).toBeNull();
  expect(
    adaptAgentHistoryResponse(response({ modelSeenUpToSeq: null })).modelSeenUpToSeq,
  ).toBeNull();
  expect(adaptAgentHistoryResponse(response({ modelSeenUpToSeq: 7 })).modelSeenUpToSeq).toBe(7);
  // A boundary that is not a positive integer is not trusted: it reads as "no boundary".
  for (const malformed of ["7", -1, 0, 2.5])
    expect(
      adaptAgentHistoryResponse(response({ modelSeenUpToSeq: malformed })).modelSeenUpToSeq,
    ).toBeNull();
});

test("a read passes a well-formed consumption scope through and drops a malformed one", () => {
  const scope = {
    agentId: "agent-a",
    conversationId: "conversation-a",
    channelType: "thread" as const,
    target: "@ada:0f0e0d0c-0b0a-4908-8706-050403020100",
  };
  expect(adaptAgentHistoryResponse(response({ consumptionScope: scope })).consumptionScope).toEqual(
    scope,
  );
  for (const malformed of [
    { ...scope, channelType: "channel" },
    { ...scope, conversationId: 7 },
    { ...scope, target: "" },
    "scope",
  ])
    expect(
      adaptAgentHistoryResponse(response({ consumptionScope: malformed })).consumptionScope,
    ).toBeUndefined();
});
