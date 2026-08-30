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
} from "./index";

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
