import { describe, expect, test } from "bun:test";

import { createConversationReconciler } from "#src/features/conversations/conversation-reconciliation";
import {
  decodeMessageAvailableEvent,
  decodeNotificationAvailableEvent,
} from "#src/features/conversations/conversation-realtime";

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
    // The `chat:user:` channel also carries `notification.available.v1`; the message decoder
    // must reject it so a subscriber ignoring undecodable publications skips it cleanly.
    expect(() =>
      decodeMessageAvailableEvent({
        type: "notification.available.v1",
        messageId: "message-a",
        workspaceId: "workspace-a",
      }),
    ).toThrow();
  });

  test("carries the sender's request id so the sender's browser can match its pending message", () => {
    const event = {
      type: "message.available.v1" as const,
      conversationId: "conversation-a",
      messageId: "message-a",
      sequence: 12,
      requestId: "5f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f",
    };
    expect(decodeMessageAvailableEvent(event)).toEqual(event);
    expect(() => decodeMessageAvailableEvent({ ...event, requestId: "" })).toThrow();
    expect(() => decodeMessageAvailableEvent({ ...event, requestId: 7 })).toThrow();
  });

  test("decodes only the versioned notification-available contract, carrying no message text", () => {
    const event = {
      type: "notification.available.v1" as const,
      messageId: "message-a",
      workspaceId: "workspace-a",
    };

    expect(decodeNotificationAvailableEvent(event)).toEqual(event);
    expect(
      decodeNotificationAvailableEvent(new TextEncoder().encode(JSON.stringify(event))),
    ).toEqual(event);
    expect(() =>
      decodeNotificationAvailableEvent({ ...event, type: "notification.available.v2" }),
    ).toThrow();
    expect(() => decodeNotificationAvailableEvent({ ...event, messageId: "" })).toThrow();
    expect(() => decodeNotificationAvailableEvent({ ...event, workspaceId: "" })).toThrow();
    expect(() =>
      decodeNotificationAvailableEvent({ type: event.type, messageId: "message-a" }),
    ).toThrow();
    // Never carries message text: an extra `body` field is not part of the contract, but the
    // decoder only reads the fields it knows, matching `decodeMessageAvailableEvent`'s style.
    expect(decodeNotificationAvailableEvent({ ...event, body: "leaked text" })).toEqual(event);
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
