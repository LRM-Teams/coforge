import { expect, test } from "bun:test";
import {
  CentrifugoWorkspaceWorkerTransport,
  type CentrifugeWorkspaceWorkerClient,
} from "../src/cloud-transport/workspace-worker-cloud-transport";

function fakeClient() {
  let connected = () => {};
  let failed = (_error: unknown) => {};
  const client: CentrifugeWorkspaceWorkerClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
      else failed = callback as (error: unknown) => void;
    },
    connect() {
      connected();
    },
    disconnect() {},
  };
  return { client, connect: () => connected(), fail: (error: unknown) => failed(error) };
}

const config = { connectionId: "connection-a", workspaceId: "workspace-a" };

test("waits for connected and does not send a business payload", async () => {
  const fake = fakeClient();
  let connected = false;
  fake.client.connect = () =>
    setTimeout(() => {
      connected = true;
      fake.connect();
    }, 0);
  const transport = new CentrifugoWorkspaceWorkerTransport(
    "wss://cloud.example/connection/websocket",
    () => fake.client,
  );
  const start = transport.start("secret", config);
  expect(connected).toBe(false);
  await start;
  expect(connected).toBe(true);
});

test("rejects connection failures", async () => {
  const fake = fakeClient();
  fake.client.connect = () => undefined;
  const transport = new CentrifugoWorkspaceWorkerTransport(
    "wss://cloud.example",
    () => fake.client,
  );
  const start = transport.start("secret", config);
  fake.fail(new Error("connection failed"));
  await expect(start).rejects.toThrow("connection failed");
});

test("stop is idempotent and a stopped transport can restart", async () => {
  const clients: ReturnType<typeof fakeClient>[] = [];
  const transport = new CentrifugoWorkspaceWorkerTransport("wss://cloud.example", () => {
    const fake = fakeClient();
    clients.push(fake);
    return fake.client;
  });
  await transport.start("secret", config);
  await transport.stop();
  await transport.stop();
  await transport.start("secret", config);
  expect(clients).toHaveLength(2);
});
