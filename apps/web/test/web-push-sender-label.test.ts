import { describe, expect, test } from "bun:test";

import type { PrismaClient } from "#src/generated/prisma/client";
import { SYSTEM_SENDER_LABEL } from "#src/features/profiles/person-name";
import { PrismaWebPushSubscriptionStore } from "#src/server/notifications/prisma-web-push-subscriptions.server";

type Sender = {
  agent: { name: string } | null;
  user: { username: string; displayName: string | null; fullName: string | null } | null;
};

/** The notification `notificationForRecipient` builds for a message from `sender`. */
async function notificationFor(input: { sender: Sender | null; channelName: string | null }) {
  const db = {
    message: {
      findUnique: async () => ({
        id: "message-1",
        body: "Build finished",
        conversationId: "conversation-1",
        workspaceId: "workspace-1",
        senderMemberId: "member-2",
        threadRootId: null,
        sender: input.sender,
        mentions: [],
        conversation: { channelName: input.channelName, workspace: { slug: "acme" } },
      }),
    },
    conversationMember: { findFirst: async () => ({ id: "member-1" }) },
  } as unknown as PrismaClient;
  return new PrismaWebPushSubscriptionStore(db).notificationForRecipient("message-1", "user-1");
}

const frank = (names: { displayName: string | null; fullName: string | null }) => ({
  agent: null,
  user: { username: "frank-an-4k2", ...names },
});

describe("the sender a Web Push notification names", () => {
  test("a person in a direct conversation is the notification title, by their label", async () => {
    expect(
      await notificationFor({
        sender: frank({ displayName: "Frankie", fullName: "Frank An" }),
        channelName: null,
      }),
    ).toMatchObject({ title: "Frankie", body: "Build finished" });
    expect(
      await notificationFor({
        sender: frank({ displayName: null, fullName: "Frank An" }),
        channelName: null,
      }),
    ).toMatchObject({ title: "Frank An" });
  });

  test("a person in a channel prefixes the preview with their label", async () => {
    expect(
      await notificationFor({
        sender: frank({ displayName: null, fullName: "Frank An" }),
        channelName: "general",
      }),
    ).toMatchObject({ title: "#general", body: "Frank An: Build finished" });
  });

  test("an Agent keeps its @handle", async () => {
    const sender = { agent: { name: "helper" }, user: null };
    expect(await notificationFor({ sender, channelName: null })).toMatchObject({
      title: "@helper",
    });
    expect(await notificationFor({ sender, channelName: "general" })).toMatchObject({
      body: "@helper: Build finished",
    });
  });

  test("a server-authored message is from the system sender, the name nobody may take", async () => {
    expect(await notificationFor({ sender: null, channelName: null })).toMatchObject({
      title: SYSTEM_SENDER_LABEL,
    });
  });
});
