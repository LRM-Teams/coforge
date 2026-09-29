import { expect, test } from "bun:test";
import { DAEMON_RECONNECT_DISCONNECT } from "@lrm/coforge-sdk/internal";

import { decodeWorkspaceDeletedEvent } from "#src/features/workspaces/workspace-realtime";
import { centrifugoWorkspaceDeletionSignals } from "#src/server/workspaces/deletion.server";

/** What one Centrifugo server API port was asked to do; `present` is each channel's presence. */
function recordingApi(present: Record<string, { client: string; user: string }[]> = {}) {
  const published: { channel: string; data: unknown }[] = [];
  const disconnected: { user: string; client: string; code: number }[] = [];
  return {
    published,
    disconnected,
    api: {
      async publishJson(channel: string, data: unknown) {
        published.push({ channel, data });
      },
      async presence(channel: string) {
        return present[channel] ?? [];
      },
      async disconnect(input: {
        user: string;
        client: string;
        disconnect: { code: number; reason: string };
      }) {
        disconnected.push({ user: input.user, client: input.client, code: input.disconnect.code });
      },
    },
  };
}

test("a deleted Workspace's open pages hear it on the Workspace's chat channel", async () => {
  const { api, published, disconnected } = recordingApi();
  await centrifugoWorkspaceDeletionSignals(() => api).workspaceDeleted("ws-1");

  expect(published.map(({ channel }) => channel)).toEqual(["chat:workspace:ws-1"]);
  expect(decodeWorkspaceDeletedEvent(published[0]!.data)).toEqual({
    type: "workspace.deleted.v1",
    workspaceId: "ws-1",
  });
  expect(decodeWorkspaceDeletedEvent({ type: "channel.updated.v1" })).toBeUndefined();
  // Pages are told, never disconnected.
  expect(disconnected).toEqual([]);
});

test("only the connections on the Workspace's daemon channels are disconnected, to reconnect", async () => {
  const { api, disconnected } = recordingApi({
    "daemon:ws-1:computer-1": [{ client: "c-1", user: "user-1" }],
    "daemon:ws-1:computer-2": [
      { client: "c-2", user: "user-2" },
      { client: "c-3", user: "user-2" },
    ],
    // The same people's other Workspace: untouched.
    "daemon:ws-2:computer-1": [{ client: "c-9", user: "user-1" }],
  });
  await centrifugoWorkspaceDeletionSignals(() => api).reconnectDaemons("ws-1", [
    "computer-1",
    "computer-2",
    "computer-offline",
  ]);

  expect(disconnected.map(({ user, client }) => `${user}/${client}`).sort()).toEqual([
    "user-1/c-1",
    "user-2/c-2",
    "user-2/c-3",
  ]);
  for (const { code } of disconnected) expect(code).toBe(DAEMON_RECONNECT_DISCONNECT.code);
});
