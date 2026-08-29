import { expect, test } from "bun:test";
import { COMPUTER_REGISTER_METHOD, RUNTIME_PROVIDER } from "@coforge/protocol";
import { encodeComputerRegisterRequest } from "@coforge/protocol/codec";
import {
  CentrifugoComputerRegisterTransport,
  cloudWebSocketEndpoint,
  type CentrifugeClient,
  type CentrifugeFactory,
} from "../src/cloud-rpc-transport";

const request = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceSlug: "team",
  machineId: "machine-1",
  platform: "linux",
  osVersion: "1",
  computerVersion: "1",
  runtimes: [{ provider: RUNTIME_PROVIDER.PI, version: "1.0.0", kind: "external" as const }],
  registrationIdempotencyKey: "registration-1",
};

const response = {
  protocolMajor: 1,
  requestId: request.requestId,
  computerId: "computer-1",
  workspaceId: "workspace-1",
  workspaceWorkerToken: "worker-secret",
};

function encodedResponse() {
  const bytes = [0x08, response.protocolMajor];
  for (const [index, value] of [
    response.requestId,
    response.computerId,
    response.workspaceId,
    `${response.workspaceId}:${response.computerId}`,
    response.workspaceWorkerToken,
  ].entries()) {
    const encoded = new TextEncoder().encode(value);
    bytes.push(0x12 + index * 8, encoded.length, ...encoded);
  }
  return new Uint8Array(bytes);
}

function fakeClient(overrides: Partial<CentrifugeClient> = {}) {
  let connected = () => {};
  let failed = (_error: unknown) => {};
  const client: CentrifugeClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
      else failed = callback as (error: unknown) => void;
    },
    connect() {
      connected();
    },
    disconnect() {},
    async rpc() {
      return { data: encodedResponse() };
    },
    ...overrides,
  };
  return {
    client,
    fail(error: unknown) {
      failed(error);
    },
  };
}

test("register transport sends the method and encoded request, then decodes the response", async () => {
  const fake = fakeClient();
  let rpcMethod = "";
  let rpcPayload: Uint8Array | undefined;
  fake.client.rpc = async (method, data) => {
    rpcMethod = method;
    rpcPayload = data;
    return { data: encodedResponse() };
  };
  const factory: CentrifugeFactory = () => fake.client;

  await expect(
    new CentrifugoComputerRegisterTransport(
      "wss://cloud.example/connection/websocket",
      "fixed-secret",
      factory,
    ).request(COMPUTER_REGISTER_METHOD, request),
  ).resolves.toEqual(response);
  expect(rpcMethod).toBe(COMPUTER_REGISTER_METHOD);
  expect(rpcPayload).toEqual(encodeComputerRegisterRequest(request));
});

test("register transport rejects connection failures and disconnects", async () => {
  let disconnects = 0;
  const fake = fakeClient({ connect: () => {}, disconnect: () => disconnects++ });
  const factory: CentrifugeFactory = () => fake.client;
  const promise = new CentrifugoComputerRegisterTransport(
    "wss://cloud.example",
    "fixed-secret",
    factory,
  ).request(COMPUTER_REGISTER_METHOD, request);
  fake.fail(new Error("connection failed"));

  await expect(promise).rejects.toThrow("connection failed");
  expect(disconnects).toBe(1);
});

test("register transport rejects RPC failures and disconnects", async () => {
  let disconnects = 0;
  const fake = fakeClient({
    disconnect: () => disconnects++,
    rpc: async () => Promise.reject(new Error("rpc failed")),
  });
  const factory: CentrifugeFactory = () => fake.client;

  await expect(
    new CentrifugoComputerRegisterTransport("wss://cloud.example", "fixed-secret", factory).request(
      COMPUTER_REGISTER_METHOD,
      request,
    ),
  ).rejects.toThrow("rpc failed");
  expect(disconnects).toBe(1);
});

test("cloud websocket endpoint uses the Centrifugo websocket path", () => {
  expect(cloudWebSocketEndpoint("https://cloud.example/api?tenant=one")).toBe(
    "wss://cloud.example/connection/websocket?tenant=one",
  );
  expect(cloudWebSocketEndpoint("http://cloud.example/api")).toBe(
    "ws://cloud.example/connection/websocket",
  );
});
