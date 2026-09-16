import { expect, test } from "bun:test";
import type {
  AgentChannelAttentionResponse,
  AgentEventsGetRequest,
  AgentEventsResponse,
  AgentMessagesResponse,
  AgentMessagesSendRequest,
  AgentThreadAttentionResponse,
} from "./messages";

test("models a message send request without internal transport fields", () => {
  const request: AgentMessagesSendRequest = {
    target: "#general",
    body: "hello",
    sendDraft: false,
  };
  expect(request).toEqual({ target: "#general", body: "hello", sendDraft: false });
});

test("models the public message response and attachment shape", () => {
  const response: AgentMessagesResponse = {
    requestId: "request-1",
    accepted: true,
    attentionCount: 0,
    messages: [
      {
        id: "message-1",
        sequence: 1,
        sender: "agent-1",
        target: "#general",
        body: "hello",
        createdAt: "2026-09-15T00:00:00.000Z",
        attachment: {
          id: "attachment-1",
          fileName: "notes.txt",
          contentType: "text/plain",
          sizeBytes: 5,
        },
      },
    ],
  };
  expect(response.messages[0]?.attachment?.contentType).toBe("text/plain");
});

test("models an events drain request and its own response shape with a hasMore continuation flag", () => {
  const request: AgentEventsGetRequest = { limit: 50 };
  const response: AgentEventsResponse = {
    protocolMajor: 1,
    requestId: "request-2",
    events: [],
    hasMore: true,
  };
  expect(request).toEqual({ limit: 50 });
  expect(response.hasMore).toBe(true);
});

test("models the channel and thread attention response shapes", () => {
  const muted: AgentChannelAttentionResponse = {
    protocolMajor: 1,
    requestId: "request-3",
    target: "#general",
    muted: true,
  };
  const unfollowed: AgentThreadAttentionResponse = {
    protocolMajor: 1,
    requestId: "request-4",
    target: "#general:12345678-0000-4000-8000-000000000001",
    followed: false,
  };
  expect(muted.muted).toBe(true);
  expect(unfollowed.followed).toBe(false);
});
