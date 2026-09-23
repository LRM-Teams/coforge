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

describe("the thread pane path stays unfiltered (#139's second rule)", () => {
  /**
   * The thread pane must keep showing every reply — the filter lives only inside the
   * `threadPreview` callback, never in `repliesOf` (the single grouping the thread pane's
   * `messages` read). Source-pinned (the same style as `message-jump-highlight`): apps/web's
   * suite renders server-side, so the guarantee "the pane reads the unfiltered grouping" is
   * what the source itself must show.
   */
  test("the pane reads the unfiltered grouping and the filter exists only in the preview", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const source = await readFile(
      join(import.meta.dir, "../src/features/conversations/direct-conversation.tsx"),
      "utf8",
    );
    // Exactly one system filter, and it is the preview's: a second occurrence would mean the
    // pane's data source was filtered too — the drift this test exists to catch.
    const filterCount = source.split('senderKind !== "system"').length - 1;
    expect(filterCount).toBe(1);
    expect(source).toContain("senderKind !== \"system\"");
    // The thread pane reads `repliesOf(...)` — the unfiltered grouping — as its messages
    // (`threadPaneProps(root)`; the open task popup's thread does too).
    expect(source).toContain("messages: repliesOf(root.id),");
    // `repliesOf` itself groups without a system filter (the pane's only data source).
    const repliesOfLine = source
      .split("\n")
      .find((line) => line.includes("const repliesOf = (rootId: string)"));
    expect(repliesOfLine).toBeDefined();
    expect(repliesOfLine?.includes("system")).toBe(false);
  });
});
