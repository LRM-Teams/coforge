import { describe, expect, test } from "bun:test";

import { createConversationReconciler } from "../src/features/conversations/conversation-reconciliation";
import { decodeMessageAvailableEvent } from "../src/features/conversations/conversation-realtime";

describe("conversation realtime", () => {
  test("decodes only the versioned message-available contract", () => {
    const event = {
      type: "message.available.v1" as const,
      conversationId: "conversation-a",
      messageId: "message-a",
      sequence: 12,
    };

    expect(decodeMessageAvailableEvent(event)).toEqual(event);
    expect(decodeMessageAvailableEvent(new TextEncoder().encode(JSON.stringify(event)))).toEqual(
      event,
    );
    expect(() => decodeMessageAvailableEvent({ ...event, type: "message.available.v2" })).toThrow();
    expect(() => decodeMessageAvailableEvent({ ...event, sequence: 0 })).toThrow();
  });

  test("drains full HTTP pages from a canonical cursor without skipping gaps", async () => {
    const messages = Array.from({ length: 205 }, (_, index) => ({
      id: `message-${index + 1}`,
      sequence: index + 1,
    }));
    const cursors: number[] = [];
    const merged: typeof messages = [];
    const reconciler = createConversationReconciler(
      0,
      async (afterSequence) => {
        cursors.push(afterSequence);
        return messages.filter((message) => message.sequence > afterSequence).slice(0, 100);
      },
      (page) => merged.push(...page),
    );

    await reconciler.reconcile();

    expect(cursors).toEqual([0, 100, 200]);
    expect(merged).toEqual(messages);
  });

  test("coalesces a signal received while reconciliation is in flight", async () => {
    let releaseFirstPage = () => {};
    let calls = 0;
    const firstPage = new Promise<Array<{ id: string; sequence: number }>>((resolve) => {
      releaseFirstPage = () => resolve([{ id: "message-1", sequence: 1 }]);
    });
    const reconciler = createConversationReconciler(
      0,
      async () => (++calls === 1 ? firstPage : []),
      () => {},
    );

    const first = reconciler.reconcile();
    const second = reconciler.reconcile();
    releaseFirstPage();
    await Promise.all([first, second]);

    expect(calls).toBe(2);
  });
});
