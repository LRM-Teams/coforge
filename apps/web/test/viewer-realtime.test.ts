import { expect, test } from "bun:test";
import {
  CentrifugoConversationRealtime,
  announceViewerEvent,
} from "#src/server/conversations/conversation-realtime.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";

function recordingCentrifugo() {
  const published: { channel: string; data: unknown; idempotencyKey?: string }[] = [];
  const centrifugo = {
    publishJson: async (channel: string, data: unknown, idempotencyKey?: string) => {
      published.push({ channel, data, idempotencyKey });
    },
  } as unknown as CentrifugoServerApi;
  return { centrifugo, published };
}

test("a viewer event goes only to each named person's own channel, never the Workspace", async () => {
  const { centrifugo, published } = recordingCentrifugo();
  const event = {
    type: "channel.joined.v1" as const,
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
  };
  await announceViewerEvent(new CentrifugoConversationRealtime(centrifugo), {
    userIds: ["ada", "grace"],
    event,
  });
  expect(published.map(({ channel, data }) => ({ channel, data }))).toEqual([
    { channel: "chat:user:ada", data: event },
    { channel: "chat:user:grace", data: event },
  ]);
});

test("announcing to nobody publishes nothing, and a failed publish never fails the write", async () => {
  const { centrifugo, published } = recordingCentrifugo();
  const event = {
    type: "pref.changed.v1" as const,
    workspaceId: "workspace-1",
    name: "pins" as const,
  };
  await announceViewerEvent(new CentrifugoConversationRealtime(centrifugo), { userIds: [], event });
  expect(published).toEqual([]);

  const failing = {
    publishJson: async () => {
      throw new Error("centrifugo down");
    },
  } as unknown as CentrifugoServerApi;
  await expect(
    announceViewerEvent(new CentrifugoConversationRealtime(failing), { userIds: ["ada"], event }),
  ).resolves.toBeUndefined();
});
