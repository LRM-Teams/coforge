import { describe, expect, test } from "bun:test";

import {
  conversationSearchWithoutAgentProfile,
  conversationSearchWithoutThread,
  conversationSearchWithThread,
  messageIdFromHash,
  positionJumpDecision,
  resolveConversationThreadRoot,
  threadRootFromMessageAnchor,
} from "#src/features/conversations/conversation-thread-search";

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
  test("opening writes threadRootId after removing the Agent panel state", () => {
    const withoutProfile = conversationSearchWithoutAgentProfile({
      view: "chat",
      profile: "agent:1",
      agentTab: "profile",
    });
    expect(conversationSearchWithThread(withoutProfile, "root-1")).toEqual({
      view: "chat",
      threadRootId: "root-1",
    });
  });

  test("closing drops threadRootId while preserving unrelated search", () => {
    expect(
      conversationSearchWithoutThread({
        view: "chat",
        profile: "agent:1",
        threadRootId: "root-1",
      }),
    ).toEqual({ view: "chat", profile: "agent:1" });
  });
});

describe("positionJumpDecision", () => {
  // apps/web's suite is renderToString-only (effects never run, no DOM harness), so the pane's
  // consume rules — the ones the boss's saved-jump ruling ("land at the message's row in the
  // stream, never in the thread") depends on — are pinned as this pure table instead of an
  // integration test: show on first sight; a notification's hash wins (consume without
  // showing); never re-show a consumed id; reset when the param clears so leaving the
  // conversation and re-clicking the same saved card jumps again.
  test("first sight without a hash shows the position jump", () => {
    expect(positionJumpDecision("message-1", "", undefined)).toEqual({
      action: "show",
      id: "message-1",
    });
  });

  test("any hash consumes the param without showing — the deep link owns the landing", () => {
    expect(positionJumpDecision("message-1", "#message-other", undefined)).toEqual({
      action: "consume",
      id: "message-1",
    });
  });

  test("the same id once consumed is ignored, so re-renders never re-jump", () => {
    expect(positionJumpDecision("message-1", "", "message-1")).toEqual({ action: "ignore" });
  });

  test("a different id is shown — the marker tracks the id, never a boolean", () => {
    // Clicking a second saved card in the same conversation right after the first was consumed
    // must still land; a future `boolean consumed` simplification would break this.
    expect(positionJumpDecision("message-2", "", "message-1")).toEqual({
      action: "show",
      id: "message-2",
    });
  });

  test("an absent param resets the marker, so re-clicking the same card jumps again", () => {
    expect(positionJumpDecision(undefined, "", "message-1")).toEqual({ action: "idle" });
    expect(positionJumpDecision("message-1", "", undefined)).toEqual({
      action: "show",
      id: "message-1",
    });
  });
});
