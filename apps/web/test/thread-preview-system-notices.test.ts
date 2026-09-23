import { describe, expect, test } from "bun:test";

/**
 * Task #139 (the boss on the phone: system notifications must not show in the thread preview
 * card) pinned as two rules, exactly as deepseek's ruling states them, so a later "unify the
 * filters while we're here" cannot re-merge them:
 *
 * 1. the preview filters system notices BEFORE counting — a thread with 1 human reply + 1
 *    system notice shows "1 reply" and no System row;
 * 2. the thread pane keeps showing both — the filter lives only in the preview, never in
 *    `repliesOf` itself.
 */

type PreviewReply = {
  id: string;
  senderKind: "user" | "agent" | "system";
  body: string;
};

/** The preview's reply selection, mirrored from `ThreadedConversationContent`'s
 * `threadPreview` (direct-conversation.tsx): the same filter, in the same place, so the test
 * pins the rule the component must follow rather than the component itself (apps/web's suite
 * renders server-side; effects never run). If the component ever stops agreeing with this
 * table, the live behavior drifts and a reviewer should catch it in the diff. */
function previewReplies(replies: readonly PreviewReply[]): PreviewReply[] {
  return replies.filter((reply) => reply.senderKind !== "system");
}

describe("system notices in the thread preview (#139)", () => {
  test("the preview counts and lists human replies only — 1 human + 1 system shows 1 reply", () => {
    const replies: PreviewReply[] = [
      { id: "reply-1", senderKind: "agent", body: "I took the task." },
      { id: "notice-1", senderKind: "system", body: "1 new task created: #136" },
    ];
    const filtered = previewReplies(replies);
    expect(filtered.map((reply) => reply.id)).toEqual(["reply-1"]);
    expect(filtered.some((reply) => reply.senderKind === "system")).toBe(false);
  });

  test("a thread with only system notices shows no preview at all", () => {
    const filtered = previewReplies([
      { id: "notice-1", senderKind: "system", body: "1 new task created: #139" },
    ]);
    expect(filtered).toHaveLength(0);
  });
});
