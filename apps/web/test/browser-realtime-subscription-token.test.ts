import { expect, test } from "bun:test";
// The JSON build shares the protobuf build's Subscription code; its text frames keep this fake
// server readable.
import { Centrifuge } from "centrifuge";

type Command = {
  id: number;
  connect?: unknown;
  subscribe?: { channel: string; token?: string };
};

const subscribeCommands: NonNullable<Command["subscribe"]>[] = [];

/**
 * A Centrifugo stand-in: the socket opens on the next task, as a real one does after `connect()`
 * returns, and every connect or subscribe command gets a success reply.
 */
class FakeCentrifugoSocket {
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onerror?: (event: unknown) => void;

  constructor() {
    setTimeout(() => this.onopen?.());
  }

  send(frame: string) {
    const replies = frame
      .split("\n")
      .map((line) => JSON.parse(line) as Command)
      .flatMap((command): object[] => {
        if (command.connect) return [{ id: command.id, connect: { client: "client-1" } }];
        if (command.subscribe) {
          subscribeCommands.push(command.subscribe);
          return [{ id: command.id, subscribe: {} }];
        }
        return [];
      });
    if (replies.length === 0) return;
    const data = replies.map((reply) => JSON.stringify(reply)).join("\n");
    queueMicrotask(() => this.onmessage?.({ data }));
  }

  close() {
    this.onclose?.({ code: 1000, reason: "" });
  }
}

test("a channel subscribed while the connection is opening asks for its subscription token once", async () => {
  // The Workspace layout hands its client to the page before the socket opens, so every page
  // subscription starts in this window. The token Server Function takes far longer than the
  // connect reply; release it only after the client has connected.
  const client = new Centrifuge("ws://realtime.test/connection/websocket", {
    token: "connection-token",
    websocket: FakeCentrifugoSocket,
  });
  let tokenRequests = 0;
  const subscription = client.newSubscription("chat:conversation-a", {
    getToken: async () => {
      tokenRequests += 1;
      await client.ready();
      return "subscription-token";
    },
  });
  try {
    client.connect();
    subscription.subscribe();
    await subscription.ready();

    expect(tokenRequests).toBe(1);
    expect(subscribeCommands.map((command) => [command.channel, command.token])).toEqual([
      ["chat:conversation-a", "subscription-token"],
    ]);
  } finally {
    client.disconnect();
  }
});
