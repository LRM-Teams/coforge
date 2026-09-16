import { expect, test } from "bun:test";
import type { AgentMessagesResponse, AgentMessagesSendRequest } from "./messages";

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
