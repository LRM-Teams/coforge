import { expect, test } from "bun:test";
import {
  CentrifugoConversationRealtime,
  announceViewerEvent,
} from "#src/server/conversations/conversation-realtime.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";

/** Records what reaches each channel, whether one `publish` or one `broadcast` carried it. */
function recordingCentrifugo() {
  const published: { channel: string; data: unknown }[] = [];
  const centrifugo = {
    publishJson: async (channel: string, data: unknown) => {
      published.push({ channel, data });
    },
    broadcast: async (channels: string[], data: unknown) => {
      for (const channel of channels) published.push({ channel, data });
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
  expect(published).toEqual([
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

  const down = async () => {
    throw new Error("centrifugo down");
  };
  const failing = { publishJson: down, broadcast: down } as unknown as CentrifugoServerApi;
  await expect(
    announceViewerEvent(new CentrifugoConversationRealtime(failing), { userIds: ["ada"], event }),
  ).resolves.toBeUndefined();
});

test("a created channel is announced to the whole Workspace", async () => {
  const { centrifugo, published } = recordingCentrifugo();
  await new CentrifugoConversationRealtime(centrifugo).channelCreated({
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    channel: { name: "lab", description: "", archived: false },
  });
  expect(published).toEqual([
    {
      channel: "chat:workspace:workspace-1",
      data: {
        type: "channel.created.v1",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        channel: { name: "lab", description: "", archived: false },
      },
    },
  ]);
});
