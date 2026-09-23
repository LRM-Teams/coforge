import { describe, expect, test } from "bun:test";

import { resolveVisibleConversationSlot } from "@/features/agents/profile-panel/profile-panel-slot";

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

  test("legacy URLs containing both params default to thread", () => {
    expect(resolveVisibleConversationSlot({ threadOpen: true, profileOpen: true })).toBe("thread");
  });

  test("has no visible panel when the active panel has been closed", () => {
    expect(
      resolveVisibleConversationSlot({ threadOpen: false, profileOpen: false }),
    ).toBeUndefined();
  });
});
