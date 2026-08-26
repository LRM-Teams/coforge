import { afterEach, describe, expect, test } from "bun:test";
import { Centrifuge, State, SubscriptionState } from "centrifuge/build/protobuf";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const clients: Centrifuge[] = [];

function connectAs(accessToken: string): Promise<Centrifuge> {
  const client = new Centrifuge(
    process.env.CENTRIFUGO_URL ?? "ws://127.0.0.1:18083/connection/websocket",
    {
      data: encoder.encode(JSON.stringify({ accessToken })),
      timeout: 3_000,
      websocket: WebSocket,
    },
  );
  clients.push(client);

  return new Promise((resolve, reject) => {
    client.once("connected", () => resolve(client));
    client.once("disconnected", (ctx) => reject(new Error(ctx.reason)));
    client.connect();
  });
}

function subscribe(
  client: Centrifuge,
  channel: string,
): Promise<ReturnType<Centrifuge["newSubscription"]>> {
  const subscription = client.newSubscription(channel);

  return new Promise((resolve, reject) => {
    subscription.once("subscribed", () => resolve(subscription));
    subscription.once("unsubscribed", (ctx) => reject(new Error(`${ctx.code}: ${ctx.reason}`)));
    subscription.subscribe();
  });
}

function nextPublication(
  subscription: ReturnType<Centrifuge["newSubscription"]>,
): Promise<unknown> {
  return new Promise((resolve) => {
    subscription.once("publication", (ctx) => resolve(JSON.parse(decoder.decode(ctx.data))));
  });
}

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.disconnect();
  }
});

describe("standalone Centrifugo harness", () => {
  test("a real Bun Protobuf client connects through the single edge", async () => {
    const client = await connectAs("alice-token");

    expect(client.state).toBe(State.Connected);
  });

  test("RPC is authorized and proxied to the backend canonical-message simulation", async () => {
    const client = await connectAs("alice-token");

    const response = await client.rpc(
      "message.publish",
      encoder.encode(
        JSON.stringify({
          clientMessageId: "client-message-1",
          conversationId: "conversation:alpha",
          text: "hello from Bun",
        }),
      ),
    );

    expect(JSON.parse(decoder.decode(response.data))).toEqual({
      clientMessageId: "client-message-1",
      conversationId: "conversation:alpha",
      messageId: "canonical:alice:client-message-1",
      sender: "alice",
      text: "hello from Bun",
    });
  });

  test("one Protobuf connection multiplexes authorized subscriptions and receives server publications", async () => {
    const client = await connectAs("alice-token");
    const alpha = await subscribe(client, "conversation:alpha");
    const shared = await subscribe(client, "conversation:shared");
    const alphaPublication = nextPublication(alpha);
    const sharedPublication = nextPublication(shared);

    await client.rpc(
      "message.publish",
      encoder.encode(
        JSON.stringify({
          clientMessageId: "client-message-alpha",
          conversationId: "conversation:alpha",
          text: "alpha message",
        }),
      ),
    );
    await client.rpc(
      "message.publish",
      encoder.encode(
        JSON.stringify({
          clientMessageId: "client-message-shared",
          conversationId: "conversation:shared",
          text: "shared message",
        }),
      ),
    );

    expect(await alphaPublication).toMatchObject({
      conversationId: "conversation:alpha",
      messageId: "canonical:alice:client-message-alpha",
    });
    expect(await sharedPublication).toMatchObject({
      conversationId: "conversation:shared",
      messageId: "canonical:alice:client-message-shared",
    });
  });

  test("backend authorization isolates users from another conversation", async () => {
    const client = await connectAs("bob-token");

    await expect(subscribe(client, "conversation:alpha")).rejects.toThrow("403: permission denied");
    await expect(
      client.rpc(
        "message.publish",
        encoder.encode(
          JSON.stringify({
            clientMessageId: "forbidden-message",
            conversationId: "conversation:alpha",
            text: "must not publish",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 403, message: "permission denied" });

    expect((await subscribe(client, "conversation:beta")).state).toBe(SubscriptionState.Subscribed);
  });
});
