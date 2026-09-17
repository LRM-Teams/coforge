import { describe, expect, test } from "bun:test";

import { resolveVisibleConversationSlot } from "../src/features/agents/profile-panel/profile-panel-slot";

describe("resolveVisibleConversationSlot", () => {
  test("shows nothing when neither panel is open", () => {
    expect(
      resolveVisibleConversationSlot({ threadOpen: false, profileOpen: false }),
    ).toBeUndefined();
  });

  test("shows the only open panel", () => {
    expect(resolveVisibleConversationSlot({ threadOpen: true, profileOpen: false })).toBe("thread");
    expect(resolveVisibleConversationSlot({ threadOpen: false, profileOpen: true })).toBe(
      "profile",
    );
  });

  test("when both are open, the most recently opened one wins", () => {
    expect(
      resolveVisibleConversationSlot({ threadOpen: true, profileOpen: true, lastOpened: "thread" }),
    ).toBe("thread");
    expect(
      resolveVisibleConversationSlot({
        threadOpen: true,
        profileOpen: true,
        lastOpened: "profile",
      }),
    ).toBe("profile");
  });

  test("both open with no ordering signal defaults to thread (its pre-existing behavior)", () => {
    expect(resolveVisibleConversationSlot({ threadOpen: true, profileOpen: true })).toBe("thread");
  });

  test("closing the visible panel reveals the other one, which this function never reports closed", () => {
    // Arbitration only picks which is visible; the caller keeps the loser's own state (e.g. a
    // visited thread stays mounted-hidden), so this function is never told to close it.
    const visible = resolveVisibleConversationSlot({
      threadOpen: true,
      profileOpen: true,
      lastOpened: "profile",
    });
    expect(visible).toBe("profile");
    expect(resolveVisibleConversationSlot({ threadOpen: true, profileOpen: false })).toBe("thread");
  });
});
