import { expect, test } from "bun:test";
import {
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_MESSAGE_METHOD,
  AGENT_MESSAGE_REJECT_METHOD,
  decodeAgentMessageDeliveryAck,
  decodeAgentMessageDeliveryRejection,
  encodeAgentMessageDeliveryAck,
  encodeAgentMessageDeliveryRejection,
  decodeAgentMessageDelivery,
  decodeAgentMessageResponse,
  encodeAgentMessageDelivery,
  encodeAgentMessageResponse,
  validateAgentMessageRequest,
  isChannelMessageTarget,
  SEEN_EXACT_SEQS_LIMIT,
} from "./index";

test("accepts the targetless events-drain check operation", () => {
  const request = {
    idempotencyKey: "request-check",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "check" as const,
    target: "",
    limit: 50,
  };
  expect(validateAgentMessageRequest(request)).toBe(request);
});

test("accepts a targeted events-drain check operation", () => {
  const request = {
    idempotencyKey: "request-check-target",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "check" as const,
    target: "@ada",
  };
  expect(validateAgentMessageRequest(request)).toBe(request);
});

test.each(["mute", "unmute"] as const)("accepts Agent channel %s", (operation) => {
  const request = {
    idempotencyKey: "request-mute",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation,
    target: "#general",
  };
  expect(validateAgentMessageRequest(request)).toBe(request);
});

test("accepts Agent channel thread unfollow", () => {
  const request = {
    idempotencyKey: "request-unfollow",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "thread-unfollow" as const,
    target: "#general:12345678-1234-4234-8234-123456789abc",
  };
  expect(validateAgentMessageRequest(request)).toBe(request);
});

test("accepts Agent message resolve", () => {
  const request = {
    idempotencyKey: "request-resolve",
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
    idempotencyKey: "request-react",
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
    idempotencyKey: "request-react",
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
    idempotencyKey: "request-resolve",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "resolve" as const,
    target: "",
  };
  expect(() => validateAgentMessageRequest(request)).toThrow("invalid cloud agent message request");
});

test("rejects an unknown operation", () => {
  const request = {
    idempotencyKey: "request-unknown",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "bogus" as unknown as "read",
    target: "#general",
  };
  expect(() => validateAgentMessageRequest(request)).toThrow("invalid cloud agent message request");
});

test("rejects a targeted operation without a target", () => {
  const request = {
    idempotencyKey: "request-read",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    operation: "read" as const,
    target: "",
  };
  expect(() => validateAgentMessageRequest(request)).toThrow("invalid cloud agent message request");
});

test("accepts Agent lexical message search filters", () => {
  const request = {
    idempotencyKey: "request-search",
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
    idempotencyKey: "send-seen",
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
    idempotencyKey: "read-seen",
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

test("accepts exact seen sequences only on send, and only as positive integers within the limit", () => {
  const send = {
    idempotencyKey: "send-exact",
    agentId: "agent-a",
    workspaceId: "workspace-a",
    operation: "send" as const,
    target: "@ada",
    content: "reply",
    seenUpToSeq: 4,
    seenExactSeqs: [6, 9],
  };
  expect(validateAgentMessageRequest(send)).toBe(send);
  expect(() =>
    validateAgentMessageRequest({ ...send, operation: "read", content: undefined }),
  ).toThrow("only valid for send");
  expect(() => validateAgentMessageRequest({ ...send, seenExactSeqs: [0] })).toThrow(
    "invalid Agent message exact seen sequences",
  );
  expect(() => validateAgentMessageRequest({ ...send, seenExactSeqs: [1.5] })).toThrow(
    "invalid Agent message exact seen sequences",
  );
  expect(() =>
    validateAgentMessageRequest({
      ...send,
      seenExactSeqs: Array.from({ length: SEEN_EXACT_SEQS_LIMIT + 1 }, (_, index) => index + 1),
    }),
  ).toThrow("invalid Agent message exact seen sequences");
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

test("round-trips an Agent delivery rejection with its delivery identity and reason", () => {
  const rejection = {
    protocolMajor: 1,
    requestId: "request-a",
    messageId: "message-a",
    deliveryId: "delivery-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    sequence: 42,
    reason: "no_process",
    method: AGENT_MESSAGE_REJECT_METHOD,
  } as const;

  expect(
    decodeAgentMessageDeliveryRejection(encodeAgentMessageDeliveryRejection(rejection)),
  ).toEqual(rejection);
});

test("refuses an Agent delivery rejection with a reason outside the closed vocabulary", () => {
  const rejection = {
    protocolMajor: 1,
    requestId: "request-a",
    messageId: "message-a",
    deliveryId: "delivery-a",
    workspaceId: "workspace-a",
    agentId: "agent-a",
    sequence: 42,
    reason: "busy" as "no_process",
    method: AGENT_MESSAGE_REJECT_METHOD,
  } as const;

  expect(() => encodeAgentMessageDeliveryRejection(rejection)).toThrow(
    "invalid agent delivery rejection",
  );
});

test("round-trips daemon-local message attention summaries", () => {
  const response = {
    idempotencyKey: "request-check",
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
    idempotencyKey: "request-read",
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
    idempotencyKey: "held",
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
    idempotencyKey: "request-events",
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
    idempotencyKey: "request-events",
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
