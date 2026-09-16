import { expect, test } from "bun:test";
import {
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_MESSAGE_METHOD,
  decodeAgentMessageDeliveryAck,
  encodeAgentMessageDeliveryAck,
  decodeAgentMessageDelivery,
  decodeAgentMessageResponse,
  decodeCloudAgentMessageResponse,
  encodeAgentMessageDelivery,
  encodeAgentMessageResponse,
  encodeCloudAgentMessageResponse,
  encodeAgentMessageRequest,
  decodeAgentMessageRequest,
  decodeLocalAgentMessageRequest,
  encodeLocalAgentMessageRequest,
  isChannelMessageTarget,
} from "./index";

test.each(["mute", "unmute"] as const)(
  "round-trips Agent channel %s over existing versioned envelopes",
  (operation) => {
    const request = {
      protocolMajor: 1,
      requestId: "request-mute",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      operation,
      target: "#general",
    };
    expect(decodeAgentMessageRequest(encodeAgentMessageRequest(request))).toMatchObject(request);
    const local = {
      requestId: "request-mute",
      context: "context-a",
      operation,
      target: "#general",
    };
    expect(decodeLocalAgentMessageRequest(encodeLocalAgentMessageRequest(local))).toMatchObject(
      local,
    );
  },
);

test("round-trips Agent channel thread unfollow over existing versioned envelopes", () => {
  const request = {
    protocolMajor: 1,
    requestId: "request-unfollow",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "thread-unfollow" as const,
    target: "#general:12345678-1234-4234-8234-123456789abc",
  };
  expect(decodeAgentMessageRequest(encodeAgentMessageRequest(request))).toMatchObject(request);
  const local = {
    requestId: "request-unfollow",
    context: "context-a",
    operation: "thread-unfollow" as const,
    target: "#general:12345678",
  };
  expect(decodeLocalAgentMessageRequest(encodeLocalAgentMessageRequest(local))).toMatchObject(
    local,
  );
});

test("round-trips Agent lexical message search filters over the HTTPS envelope", () => {
  const request = {
    protocolMajor: 1,
    requestId: "request-search",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "search",
    target: "#general",
    query: "release plan",
    sender: "@ada",
    sort: "recent",
    before: "2026-09-07T12:00:00Z",
    limit: 10,
    offset: 2,
  } as const;
  expect(decodeAgentMessageRequest(encodeAgentMessageRequest(request))).toMatchObject(request);
});

test("accepts full and short channel thread targets without treating them as mute targets", () => {
  expect(isChannelMessageTarget("#general")).toBe(true);
  expect(isChannelMessageTarget("#general:12345678")).toBe(true);
  expect(isChannelMessageTarget("#general:12345678-1234-4234-8234-123456789abc")).toBe(true);
  expect(isChannelMessageTarget("#general:reply-id")).toBe(false);
});

test("round-trips an Agent direct message delivery", () => {
  const delivery = {
    protocolMajor: 1,
    requestId: "request-a",
    messageId: "message-a",
    deliveryId: "delivery-a",
    sequence: 42,
    workspaceId: "workspace-a",
    conversationId: "conversation-a",
    agentId: "agent-a",
    body: "Please inspect the repository",
    method: AGENT_MESSAGE_METHOD,
  } as const;

  expect(decodeAgentMessageDelivery(encodeAgentMessageDelivery(delivery))).toEqual(delivery);
});

test("round-trips only safe positive trusted model-seen sequences", () => {
  const request = {
    protocolMajor: 1,
    requestId: "send-seen",
    agentId: "agent-a",
    workspaceId: "workspace-a",
    operation: "send" as const,
    target: "@ada",
    body: "reply",
    seenUpToSequence: 42,
  };
  expect(decodeAgentMessageRequest(encodeAgentMessageRequest(request))).toMatchObject(request);
  expect(() => encodeAgentMessageRequest({ ...request, seenUpToSequence: 0 })).toThrow("positive");
  expect(() =>
    encodeAgentMessageRequest({ ...request, seenUpToSequence: Number.MAX_SAFE_INTEGER + 1 }),
  ).toThrow("sequence");
});

test("rejects seen-up-to sequences on non-send operations", () => {
  const request = {
    protocolMajor: 1,
    requestId: "read-seen",
    agentId: "agent-a",
    workspaceId: "workspace-a",
    operation: "read" as const,
    target: "@ada",
    seenUpToSequence: 42,
  };
  expect(() => encodeAgentMessageRequest(request)).toThrow("only valid for send");

  const bytes = encodeAgentMessageRequest({ ...request, operation: "send", body: "reply" });
  const operationOffset = new TextDecoder().decode(bytes).indexOf("send");
  expect(operationOffset).toBeGreaterThanOrEqual(0);
  bytes.set(new TextEncoder().encode("read"), operationOffset);
  expect(() => decodeAgentMessageRequest(bytes)).toThrow("only valid for send");
});

test("round-trips all Agent delivery ACK identity and ordering fields", () => {
  const ack = {
    protocolMajor: 1,
    requestId: "request-a",
    messageId: "message-a",
    deliveryId: "delivery-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    sequence: 42,
    method: AGENT_MESSAGE_ACK_METHOD,
  } as const;

  expect(decodeAgentMessageDeliveryAck(encodeAgentMessageDeliveryAck(ack))).toMatchObject(ack);
});

test("round-trips daemon-local message attention summaries", () => {
  const response = {
    requestId: "request-check",
    accepted: true,
    attentionCount: 2,
    summaries: [
      {
        target: "@ada",
        pendingCount: 2,
        firstPendingSequence: 4,
        latestSequence: 7,
        latestSender: "@ada",
        flags: ["dm"],
      },
    ],
    messages: [],
    messageId: "",
  };
  expect(decodeAgentMessageResponse(encodeAgentMessageResponse(response))).toEqual(response);
});

test("round-trips Agent Inbox freshness request and held response", () => {
  const request = {
    requestId: "retry",
    context: "context",
    operation: "send" as const,
    target: "@ada",
    body: "reply",
    continueAnyway: true,
  };
  expect(decodeLocalAgentMessageRequest(encodeLocalAgentMessageRequest(request))).toEqual(request);
  const response = {
    requestId: "held",
    accepted: false,
    attentionCount: 1,
    summaries: [],
    messages: [],
    messageId: "",
    sideEffectDecision: "hold" as const,
    seenUpToSequence: 7,
  };
  expect(decodeAgentMessageResponse(encodeAgentMessageResponse(response))).toEqual(response);
});

test("round-trips attachment metadata in Agent message history", () => {
  const value = {
    protocolMajor: 1,
    requestId: "request-attachment",
    accepted: true,
    attentionCount: 0,
    messages: [
      {
        id: "message-attachment",
        sequence: 1,
        sender: "@frank",
        body: "see file",
        createdAt: "2026-08-30T00:00:00Z",
        target: "@agent",
        attachment: {
          id: "attachment-1",
          fileName: "report.pdf",
          contentType: "application/pdf",
          sizeBytes: 42,
        },
      },
    ],
  };
  expect(decodeCloudAgentMessageResponse(encodeCloudAgentMessageResponse(value))).toEqual(value);
});
