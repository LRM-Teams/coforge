import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  CentrifugoConversationRealtime,
  conversationSignalScopes,
} from "#src/server/conversations/conversation-realtime.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";

const directConversation = (
  directKey: string,
  members: { userId: string | null; agentId: string | null }[],
) =>
  ({
    conversation: { findUnique: async () => ({ channelName: null, directKey, members }) },
  }) as unknown as PrismaClient;

function recordingCentrifugo() {
  const published: { channel: string; data: Record<string, unknown> }[] = [];
  const centrifugo = {
    publishJson: async (channel: string, data: Record<string, unknown>) => {
      published.push({ channel, data });
    },
  } as unknown as CentrifugoServerApi;
  return { centrifugo, published };
}

test("a direct conversation between people signals only its members, never the Workspace", async () => {
  const scopes = await conversationSignalScopes(
    directConversation("user:ada|user:grace", [
      { userId: "ada", agentId: null },
      { userId: "grace", agentId: null },
    ]),
    "conversation-1",
    "workspace-1",
  );
  const { centrifugo, published } = recordingCentrifugo();
  const realtime = new CentrifugoConversationRealtime(centrifugo);
  await realtime.messageAvailable({
    conversationId: "conversation-1",
    messageId: "message-1",
    sequence: 1,
    ...scopes.message,
  });
  await realtime.taskChanged({
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    tasks: [],
    deleted: [],
    publicationId: "p1",
    ...scopes.task,
  });

  expect(published.map((publication) => publication.channel).sort()).toEqual([
    "chat:conversation-1",
    "chat:user:ada",
    "chat:user:ada",
    "chat:user:grace",
    "chat:user:grace",
  ]);
  // Each member's badge is keyed by the other person.
  const messageTo = (channel: string) =>
    published.find(
      (publication) =>
        publication.channel === channel && publication.data.type === "message.available.v1",
    )?.data;
  expect(messageTo("chat:user:ada")?.peerUserId).toBe("grace");
  expect(messageTo("chat:user:grace")?.peerUserId).toBe("ada");
});

test("a member's conversation with themself signals only them", async () => {
  const scopes = await conversationSignalScopes(
    directConversation("user:ada|user:ada", [{ userId: "ada", agentId: null }]),
    "conversation-2",
    "workspace-1",
  );
  const { centrifugo, published } = recordingCentrifugo();
  await new CentrifugoConversationRealtime(centrifugo).messageAvailable({
    conversationId: "conversation-2",
    messageId: "message-2",
    sequence: 1,
    ...scopes.message,
  });
  expect(published.map((publication) => publication.channel).sort()).toEqual([
    "chat:conversation-2",
    "chat:user:ada",
  ]);
  expect(published.find((p) => p.channel === "chat:user:ada")?.data.peerUserId).toBe("ada");
});

test("a member still hears the other named as their peer after the other's member row is gone", async () => {
  const scopes = await conversationSignalScopes(
    directConversation("user:ada|user:grace", [{ userId: "ada", agentId: null }]),
    "conversation-3",
    "workspace-1",
  );
  const { centrifugo, published } = recordingCentrifugo();
  await new CentrifugoConversationRealtime(centrifugo).messageAvailable({
    conversationId: "conversation-3",
    messageId: "message-3",
    sequence: 1,
    ...scopes.message,
  });
  expect(published.map((publication) => publication.channel).sort()).toEqual([
    "chat:conversation-3",
    "chat:user:ada",
  ]);
  expect(published.find((p) => p.channel === "chat:user:ada")?.data.peerUserId).toBe("grace");
});
