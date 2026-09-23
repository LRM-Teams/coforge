import { describe, expect, test } from "bun:test";

import { createCentrifugoNotificationPublisher } from "@/server/notifications/in-page-notification-publisher.server";
import { userConversationChannel } from "@/features/conversations/conversation-realtime";

describe("createCentrifugoNotificationPublisher", () => {
  test("broadcasts one bodiless notification.available.v1 event to every recipient's own channel", async () => {
    const calls: Array<{ channels: string[]; data: unknown; idempotencyKey?: string }> = [];
    const publisher = createCentrifugoNotificationPublisher({
      broadcast: async (channels, data, idempotencyKey) => {
        calls.push({ channels, data, idempotencyKey });
      },
    });

    await publisher.notifyRecipients({
      messageId: "message-a",
      workspaceId: "workspace-a",
      userIds: ["user-1", "user-2"],
    });

    expect(calls).toEqual([
      {
        channels: [userConversationChannel("user-1"), userConversationChannel("user-2")],
        data: {
          type: "notification.available.v1",
          messageId: "message-a",
          workspaceId: "workspace-a",
        },
        idempotencyKey: "notification:message-a",
      },
    ]);
    // Never message text: only the fields the wire contract declares.
    expect(Object.keys(calls[0]!.data as object).sort()).toEqual(
      ["messageId", "type", "workspaceId"].sort(),
    );
  });

  test("never calls the Centrifugo API for zero recipients", async () => {
    let called = false;
    const publisher = createCentrifugoNotificationPublisher({
      broadcast: async () => {
        called = true;
      },
    });

    await publisher.notifyRecipients({
      messageId: "message-a",
      workspaceId: "workspace-a",
      userIds: [],
    });

    expect(called).toBe(false);
  });
});
