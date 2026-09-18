import { describe, expect, test } from "bun:test";

import {
  conversationSearchWithoutThread,
  conversationSearchWithThread,
  messageIdFromHash,
  resolveConversationThreadRoot,
  threadRootFromMessageAnchor,
} from "../src/features/conversations/conversation-thread-search";

const root = { id: "root-1" };
const reply = { id: "reply-1", threadRootId: "root-1" };

describe("messageIdFromHash", () => {
  test("reads the message id from a message hash", () => {
    expect(messageIdFromHash("#message-root-1")).toBe("root-1");
    expect(messageIdFromHash("")).toBeUndefined();
    expect(messageIdFromHash("#other")).toBeUndefined();
    expect(messageIdFromHash("#message-")).toBeUndefined();
  });
});

describe("threadRootFromMessageAnchor", () => {
  test("returns nothing without a message hash", () => {
    expect(threadRootFromMessageAnchor([root, reply], "")).toBeUndefined();
    expect(threadRootFromMessageAnchor([root, reply], "#other")).toBeUndefined();
  });

  test("names the root when the hash is the root message", () => {
    expect(threadRootFromMessageAnchor([root, reply], "#message-root-1")).toBe("root-1");
  });

  test("names the parent root when the hash is a reply", () => {
    expect(threadRootFromMessageAnchor([root, reply], "#message-reply-1")).toBe("root-1");
  });

  test("returns nothing when the hashed message is not loaded", () => {
    expect(threadRootFromMessageAnchor([root], "#message-missing")).toBeUndefined();
  });
});

describe("resolveConversationThreadRoot", () => {
  test("is closed when search has no threadRootId", () => {
    expect(
      resolveConversationThreadRoot({ searchThreadRootId: undefined, messages: [root, reply] }),
    ).toBeUndefined();
  });

  test("opens the root named in search", () => {
    expect(
      resolveConversationThreadRoot({ searchThreadRootId: "root-1", messages: [root, reply] }),
    ).toBe("root-1");
  });

  test("resolves a reply id in search to its parent root", () => {
    expect(
      resolveConversationThreadRoot({ searchThreadRootId: "reply-1", messages: [root, reply] }),
    ).toBe("root-1");
  });

  test("keeps a not-yet-loaded search id so the page can fetch it", () => {
    expect(resolveConversationThreadRoot({ searchThreadRootId: "missing", messages: [root] })).toBe(
      "missing",
    );
  });
});

describe("conversation thread search updates", () => {
  test("opening writes threadRootId and keeps the rest of search", () => {
    expect(conversationSearchWithThread({ view: "chat", profile: "agent:1" }, "root-1")).toEqual({
      view: "chat",
      profile: "agent:1",
      threadRootId: "root-1",
    });
  });

  test("closing drops threadRootId and keeps the rest of search", () => {
    expect(
      conversationSearchWithoutThread({
        view: "chat",
        profile: "agent:1",
        threadRootId: "root-1",
      }),
    ).toEqual({ view: "chat", profile: "agent:1" });
  });
});
