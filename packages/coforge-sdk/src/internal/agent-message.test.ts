import { expect, test } from "bun:test";
import {
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_MESSAGE_METHOD,
  decodeAgentMessageDeliveryAck,
  encodeAgentMessageDeliveryAck,
  decodeAgentMessageDelivery,
  decodeAgentMessageResponse,
  encodeAgentMessageDelivery,
  encodeAgentMessageResponse,
  validateAgentMessageRequest,
  isChannelMessageTarget,
} from "./index";

test("accepts the targetless events-drain check operation", () => {
  const request = {
    protocolMajor: 1,
    requestId: "request-check",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "check" as const,
    target: "",
    limit: 50,
  };
  expect(validateAgentMessageRequest(request)).toBe(request);
});

test.each(["mute", "unmute"] as const)("accepts Agent channel %s", (operation) => {
  const request = {
    protocolMajor: 1,
    requestId: "request-mute",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation,
    target: "#general",
  };
  expect(validateAgentMessageRequest(request)).toBe(request);
});

test("accepts Agent channel thread unfollow", () => {
  const request = {
    protocolMajor: 1,
    requestId: "request-unfollow",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "thread-unfollow" as const,
    target: "#general:12345678-1234-4234-8234-123456789abc",
  };
  expect(validateAgentMessageRequest(request)).toBe(request);
});

test("accepts Agent message resolve", () => {
  const request = {
    protocolMajor: 1,
    requestId: "request-resolve",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "resolve" as const,
    target: "",
    messageId: "12345678",
  };
  expect(validateAgentMessageRequest(request)).toBe(request);
});

test.each(["react", "unreact"] as const)("accepts Agent message %s", (operation) => {
  const request = {
    protocolMajor: 1,
    requestId: "request-react",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation,
    target: "",
    messageId: "12345678-1234-4234-8234-123456789abc",
    emoji: "👍",
  };
  expect(validateAgentMessageRequest(request)).toBe(request);
});

test("rejects a cloud react request without an emoji", () => {
  const request = {
    protocolMajor: 1,
    requestId: "request-react",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "react" as const,
    target: "",
    messageId: "12345678",
  };
  expect(() => validateAgentMessageRequest(request)).toThrow("invalid cloud agent message request");
});

test("rejects a cloud resolve request without a message id", () => {
  const request = {
    protocolMajor: 1,
    requestId: "request-resolve",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "resolve" as const,
    target: "",
  };
  expect(() => validateAgentMessageRequest(request)).toThrow("invalid cloud agent message request");
});

test("rejects an unknown operation", () => {
  const request = {
    protocolMajor: 1,
    requestId: "request-unknown",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "bogus" as unknown as "read",
    target: "#general",
  };
  expect(() => validateAgentMessageRequest(request)).toThrow("invalid cloud agent message request");
});

test("rejects a targeted operation without a target", () => {
  const request = {
    protocolMajor: 1,
    requestId: "request-read",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "read" as const,
    target: "",
  };
  expect(() => validateAgentMessageRequest(request)).toThrow("invalid cloud agent message request");
});

test("accepts Agent lexical message search filters", () => {
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
  expect(validateAgentMessageRequest(request)).toBe(request);
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

test("round-trips mentionsAgent on an Agent delivery", () => {
  for (const mentionsAgent of [true, false] as const) {
    const delivery = {
      protocolMajor: 1,
      requestId: `request-mention-${mentionsAgent}`,
      messageId: `message-mention-${mentionsAgent}`,
      deliveryId: `delivery-mention-${mentionsAgent}`,
      sequence: 3,
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      agentId: "agent-a",
      body: "please look",
      method: AGENT_MESSAGE_METHOD,
      target: "#general",
      mentionsAgent,
    } as const;

    expect(decodeAgentMessageDelivery(encodeAgentMessageDelivery(delivery))).toEqual(delivery);
  }
});

test("accepts a trusted model-seen sequence on send", () => {
  const request = {
    protocolMajor: 1,
    requestId: "send-seen",
    agentId: "agent-a",
    workspaceId: "workspace-a",
    operation: "send" as const,
    target: "@ada",
    content: "reply",
    seenUpToSeq: 42,
  };
  expect(validateAgentMessageRequest(request)).toBe(request);
});

test("rejects seen-up-to sequences on non-send operations", () => {
  const request = {
    protocolMajor: 1,
    requestId: "read-seen",
    agentId: "agent-a",
    workspaceId: "workspace-a",
    operation: "read" as const,
    target: "@ada",
    seenUpToSeq: 42,
  };
  expect(() => validateAgentMessageRequest(request)).toThrow("only valid for send");
  expect(
    validateAgentMessageRequest({ ...request, operation: "send", content: "reply" }),
  ).toMatchObject({ operation: "send" });
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
        latestSenderKind: "human" as const,
        latestSenderHandle: "ada",
        flags: ["dm"],
      },
    ],
    messages: [],
    messageId: "",
  };
  expect(decodeAgentMessageResponse(encodeAgentMessageResponse(response))).toEqual(response);
});

test("round-trips a message whose Task owner is a deleted Agent", () => {
  const response = {
    requestId: "request-read",
    accepted: true,
    attentionCount: 0,
    summaries: [],
    messages: [
      {
        id: "message-46",
        sequence: 46,
        senderKind: "human" as const,
        senderHandle: "ada",
        senderDescription: "",
        target: "#general",
        body: "Ship the login page",
        createdAt: "2026-09-24T10:00:00Z",
        attachments: [],
        task: {
          number: 46,
          status: "in_progress" as const,
          owner: { displayName: "Kiro", handle: "kiro", deleted: true },
        },
      },
    ],
    messageId: "",
  };
  expect(decodeAgentMessageResponse(encodeAgentMessageResponse(response))).toEqual(response);
});

test("round-trips an Agent Inbox held response", () => {
  const response = {
    requestId: "held",
    accepted: false,
    attentionCount: 1,
    summaries: [],
    messages: [],
    messageId: "",
    state: "held" as const,
    decision: "local_hold" as const,
    newMessageCount: 3,
    continueAnywaySuggested: true,
  };
  expect(decodeAgentMessageResponse(encodeAgentMessageResponse(response))).toEqual(response);
});

test("round-trips the daemon-local events drain hasMore flag for the CLI", () => {
  const local = {
    requestId: "request-events",
    accepted: true,
    attentionCount: 2,
    summaries: [],
    messages: [],
    messageId: "",
    hasMore: true,
  };
  expect(decodeAgentMessageResponse(encodeAgentMessageResponse(local))).toEqual(local);
});

test("withholds the daemon-local events drain hasMore flag under reviewer isolation", () => {
  const local = {
    requestId: "request-events",
    accepted: true,
    attentionCount: 2,
    summaries: [],
    messages: [],
    messageId: "",
    hasMore: true,
    freshnessContextMode: "withheld" as const,
  };
  expect(decodeAgentMessageResponse(encodeAgentMessageResponse(local)).hasMore).toBeUndefined();
});
