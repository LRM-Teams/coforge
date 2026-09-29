import { expect, test } from "bun:test";

import { decodeWorkspaceDeletedEvent } from "#src/features/workspaces/workspace-realtime";
import { centrifugoWorkspaceDeletionSignals } from "#src/server/workspaces/deletion.server";

/** What one Centrifugo server API port was asked to do. */
function recordingApi() {
  const published: { channel: string; data: unknown }[] = [];
  const disconnected: { user: string; code: number }[] = [];
  return {
    published,
    disconnected,
    api: {
      async publishJson(channel: string, data: unknown) {
        published.push({ channel, data });
      },
      async disconnect(user: string, disconnect: { code: number; reason: string }) {
        disconnected.push({ user, code: disconnect.code });
      },
    },
  };
}

test("a deleted Workspace's open pages hear it on the Workspace's chat channel", async () => {
  const { api, published } = recordingApi();
  await centrifugoWorkspaceDeletionSignals(() => api).workspaceDeleted("ws-1");

  expect(published.map(({ channel }) => channel)).toEqual(["chat:workspace:ws-1"]);
  expect(decodeWorkspaceDeletedEvent(published[0]!.data)).toEqual({
    type: "workspace.deleted.v1",
    workspaceId: "ws-1",
  });
  expect(decodeWorkspaceDeletedEvent({ type: "channel.updated.v1" })).toBeUndefined();
});

test("the people whose daemons it held are disconnected with a code their clients reconnect on", async () => {
  const { api, disconnected } = recordingApi();
  await centrifugoWorkspaceDeletionSignals(() => api).reconnectDaemons(["user-1", "user-2"]);

  expect(disconnected.map(({ user }) => user)).toEqual(["user-1", "user-2"]);
  // centrifuge-js reconnects below 3500 and in 4000-4499; 3500-3999 and 4500-4999 are terminal.
  for (const { code } of disconnected) expect(code >= 4000 && code < 4500).toBe(true);
});
