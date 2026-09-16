import { expect, test } from "bun:test";
import {
  COMPUTER_REGISTER_METHOD,
  COMPUTER_REGISTER_PROTOCOL_MAJOR,
} from "@lrm/coforge-sdk/internal";
import {
  decodeComputerRegisterRequest,
  decodeWorkspaceGetRequest,
  encodeComputerRegisterResponse,
  encodeWorkspaceGetResponse,
} from "@lrm/coforge-sdk/internal/codec";
import {
  HttpComputerRegisterTransport,
  HttpWorkspaceRpcTransport,
  centrifugoWebSocketEndpoint,
  daemonConnectionEndpoint,
  resolveDaemonConnectionEndpoint,
} from "../src/cloud-rpc-transport";

const request = {
  protocolMajor: COMPUTER_REGISTER_PROTOCOL_MAJOR,
  requestId: "request-1",
  workspaceSlug: "team",
  name: "test-computer",
  displayName: "Test Computer",
  machineId: "machine-1",
  platform: "linux",
  osVersion: "1",
  computerVersion: "1",
  registrationIdempotencyKey: "registration-1",
};

const response = {
  protocolMajor: COMPUTER_REGISTER_PROTOCOL_MAJOR,
  requestId: request.requestId,
  computerId: "computer-1",
  workspaceId: "workspace-1",
  daemonApiKey: "worker-secret",
};

test("HTTP registration sends bearer JSON without redirects and decodes protobuf", async () => {
  const transport = new HttpComputerRegisterTransport(
    "https://cloud.example/base",
    "user-secret",
    async (input, init) => {
      expect(String(input)).toBe("https://cloud.example/api/computer/attach");
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: "Bearer user-secret",
          "Content-Type": "application/json",
        },
      });
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body)).toEqual(["b64data"]);
      expect(decodeComputerRegisterRequest(Uint8Array.fromBase64(body.b64data))).toEqual(request);
      return Response.json({
        result: { b64data: encodeComputerRegisterResponse(response).toBase64() },
      });
    },
  );

  await expect(transport.request(COMPUTER_REGISTER_METHOD, request)).resolves.toEqual(response);
});

test("HTTP Workspace lookup sends and correlates its protobuf request", async () => {
  const transport = new HttpWorkspaceRpcTransport(async (input, init) => {
    expect(String(input)).toBe("https://cloud.example/api/computer/workspace");
    const body = JSON.parse(String(init?.body));
    const decoded = decodeWorkspaceGetRequest(Uint8Array.fromBase64(body.b64data));
    expect(Object.keys(body)).toEqual(["b64data"]);
    expect(decoded.workspaceSlug).toBe("team");
    return Response.json({
      result: {
        b64data: encodeWorkspaceGetResponse({
          protocolMajor: decoded.protocolMajor,
          requestId: decoded.requestId,
          workspace: { id: "workspace-1", slug: "team", name: "Team" },
        }).toBase64(),
      },
    });
  });

  await expect(
    transport.getBySlug(
      "https://cloud.example",
      { accessToken: "user-secret", tokenType: "Bearer" },
      "team",
    ),
  ).resolves.toEqual({ id: "workspace-1", slug: "team", name: "Team" });
});

test("HTTP authentication code and status 401 expire login, but other authorization fails remotely", async () => {
  for (const response of [
    new Response(null, { status: 401 }),
    Response.json({ error: { code: 401, message: "expired" } }),
    Response.json({ error: { code: 403, message: "forbidden" } }, { status: 403 }),
  ]) {
    const transport = new HttpWorkspaceRpcTransport(async () => response);
    await expect(
      transport.getBySlug(
        "https://cloud.example",
        { accessToken: "user-secret", tokenType: "Bearer" },
        "team",
      ),
    ).rejects.toMatchObject(
      response.status === 401 || response.status === 200
        ? { code: "AUTH_LOGIN_EXPIRED" }
        : { name: "RemoteRpcError", code: 403 },
    );
  }
});

test("HTTP rejects valid protobuf responses for a different request", async () => {
  const registration = new HttpComputerRegisterTransport(
    "https://cloud.example",
    "token",
    async () =>
      Response.json({
        result: {
          b64data: encodeComputerRegisterResponse({
            ...response,
            requestId: "other-request",
          }).toBase64(),
        },
      }),
  );
  await expect(registration.request(COMPUTER_REGISTER_METHOD, request)).rejects.toThrow(
    "Invalid registration response",
  );
  const workspace = new HttpWorkspaceRpcTransport(async () =>
    Response.json({
      result: {
        b64data: encodeWorkspaceGetResponse({
          protocolMajor: 1,
          requestId: "other-request",
          workspace: { id: "workspace-1", slug: "team", name: "Team" },
        }).toBase64(),
      },
    }),
  );
  await expect(
    workspace.getBySlug(
      "https://cloud.example",
      { accessToken: "token", tokenType: "Bearer" },
      "team",
    ),
  ).rejects.toThrow("Invalid Workspace response");
});

test("HTTP malformed envelope, protobuf, and network failures are remote RPC errors", async () => {
  const responses: Array<() => Promise<Response>> = [
    async () => Response.json({ result: {} }),
    async () => Response.json({ result: { b64data: "not base64!" } }),
    async () => Response.json({ result: { b64data: "AA==" } }),
    async () => {
      throw new Error("network included user-secret and request body");
    },
  ];
  for (const fetchImplementation of responses) {
    const transport = new HttpComputerRegisterTransport(
      "https://cloud.example",
      "user-secret",
      fetchImplementation,
    );
    try {
      await transport.request(COMPUTER_REGISTER_METHOD, request);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toMatchObject({
        name: "RemoteRpcError",
        method: COMPUTER_REGISTER_METHOD,
        requestId: request.requestId,
      });
      expect((error as Error).message).not.toContain("user-secret");
      expect((error as Error).message).not.toContain("request body");
    }
  }
});

test("Daemon WSS endpoint utilities remain available", () => {
  expect(centrifugoWebSocketEndpoint("https://cloud.example/api?tenant=one")).toBe(
    "wss://cloud.example/connection/websocket?tenant=one",
  );
  expect(daemonConnectionEndpoint("http://cloud.example/api")).toBe(
    "ws://cloud.example/connection/websocket",
  );
  expect(
    resolveDaemonConnectionEndpoint("http://localhost:8789", {
      COFORGE_E2E_ALLOW_DEVICE_AUTH: "1",
      COFORGE_E2E_DAEMON_CONNECTION_ENDPOINT: "ws://localhost:8000/connection/websocket",
    }),
  ).toBe("ws://localhost:8000/connection/websocket");
});
