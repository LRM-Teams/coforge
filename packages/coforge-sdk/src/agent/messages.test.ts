import { expect, test } from "bun:test";
import type {
  AgentChannelAttentionResponse,
  AgentEventsGetRequest,
  AgentEventsResponse,
  AgentHistoryResponse,
  AgentSearchResponse,
  AgentSendResponse,
  AgentResolveResponse,
  AgentReactionResponse,
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

test("models the read route's own response shape, including multiple attachments and Task metadata", () => {
  const response: AgentHistoryResponse = {
    protocolMajor: 1,
    idempotencyKey: "request-1",
    messages: [
      {
        id: "message-1",
        sequence: 1,
        senderKind: "agent",
        senderHandle: "agent-1",
        senderDescription: "",
        target: "#general",
        body: "hello",
        createdAt: "2026-09-15T00:00:00.000Z",
        attachments: [
          {
            id: "attachment-1",
            fileName: "notes.txt",
            contentType: "text/plain",
            sizeBytes: 5,
          },
          {
            id: "attachment-2",
            fileName: "diagram.png",
            contentType: "image/png",
            sizeBytes: 10,
          },
        ],
        task: {
          number: 42,
          status: "in_progress",
          owner: { displayName: "Ada", handle: "@ada" },
        },
      },
    ],
    hasOlder: false,
    hasNewer: false,
  };
  expect(response.messages[0]?.attachments).toHaveLength(2);
  expect(response.messages[0]?.attachments[0]?.contentType).toBe("text/plain");
  expect(response.messages[0]?.task?.status).toBe("in_progress");
});

test("models the dedicated search route's own response shape", () => {
  const response: AgentSearchResponse = {
    protocolMajor: 1,
    idempotencyKey: "request-search",
    results: [],
  };
  expect(response.results).toEqual([]);
});

test("models the send route's state discriminant and held context", () => {
  const held: AgentSendResponse = {
    protocolMajor: 1,
    idempotencyKey: "request-send-held",
    state: "held",
    decision: "local_hold",
    reason: "exact_target_pending",
    availableActions: ["check_messages", "send_draft", "send_anyway"],
    continueAnywaySuggested: true,
    heldMessages: [
      {
        id: "message-2",
        sequence: 2,
        senderKind: "human",
        senderHandle: "ada",
        senderDescription: "",
        target: "#general",
        body: "newer",
        createdAt: "2026-09-15T00:00:01.000Z",
        attachments: [],
      },
    ],
  };
  const bypassed: AgentSendResponse = {
    protocolMajor: 1,
    idempotencyKey: "request-send-bypass",
    state: "sent",
    decision: "bypass",
    reason: "continue_anyway",
    messageId: "message-3",
  };
  expect(held.state).toBe("held");
  expect(held.heldMessages).toHaveLength(1);
  expect(bypassed.decision).toBe("bypass");
  expect(bypassed.heldMessages).toBeUndefined();
});

test("models the resolve route's own response shape", () => {
  const response: AgentResolveResponse = {
    protocolMajor: 1,
    idempotencyKey: "request-resolve",
    message: {
      id: "message-4",
      sequence: 4,
      senderKind: "human",
      senderHandle: "ada",
      senderDescription: "",
      target: "#general",
      body: "resolved",
      createdAt: "2026-09-15T00:00:02.000Z",
      attachments: [],
    },
  };
  expect(response.message.id).toBe("message-4");
});

test("models the reaction route's own response shape", () => {
  const response: AgentReactionResponse = {
    protocolMajor: 1,
    idempotencyKey: "request-react",
    messageId: "message-4",
    emoji: "👍",
    active: true,
  };
  expect(response.active).toBe(true);
});

test("models an events drain request and its own response shape with a hasMore continuation flag", () => {
  const request: AgentEventsGetRequest = { limit: 50 };
  const response: AgentEventsResponse = {
    protocolMajor: 1,
    idempotencyKey: "request-2",
    events: [],
    hasMore: true,
  };
  expect(request).toEqual({ limit: 50 });
  expect(response.hasMore).toBe(true);
});

test("models the channel and thread attention response shapes", () => {
  const muted: AgentChannelAttentionResponse = {
    protocolMajor: 1,
    idempotencyKey: "request-3",
    target: "#general",
    muted: true,
  };
  const unfollowed: AgentThreadAttentionResponse = {
    protocolMajor: 1,
    idempotencyKey: "request-4",
    target: "#general:12345678-0000-4000-8000-000000000001",
    followed: false,
  };
  expect(muted.muted).toBe(true);
  expect(unfollowed.followed).toBe(false);
});
