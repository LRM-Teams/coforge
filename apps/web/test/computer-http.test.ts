import { describe, expect, test } from "bun:test";
import { COMPUTER_REGISTER_METHOD, WORKSPACE_GET_METHOD } from "@lrm/coforge-sdk/internal";
import {
  decodeComputerRegisterResponse,
  decodeWorkspaceGetResponse,
  encodeComputerRegisterRequest,
  encodeWorkspaceGetRequest,
} from "@lrm/coforge-sdk/internal";

import { createComputerHttpHandler } from "#src/server/computers/computer-http.server";
import { WorkspaceQueryUseCase } from "#src/server/workspaces/query.server";

const request = (path: "attach" | "workspace", payload: Uint8Array, token = "user-token") =>
  new Request(`https://server.example/api/computer/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ b64data: Buffer.from(payload).toString("base64") }),
  });

const handler = () =>
  createComputerHttpHandler({
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer user-token" ? { userId: "user-1" } : null,
    workspaceQuery: new WorkspaceQueryUseCase({
      listAccessible: async () => [],
      getAccessibleBySlug: async (slug, principal) =>
        slug === "alpha" && principal.userId === "user-1"
          ? { id: "workspace-1", slug, name: "Alpha" }
          : undefined,
    }),
    registration: {
      register: async (request, principal) => ({
        protocolMajor: 1,
        requestId: request.requestId,
        computerId: "computer-1",
        workspaceId: "workspace-1",
        workspaceSlug: request.workspaceSlug,
        daemonApiKey: principal?.userId === "user-1" ? "daemon-key" : "",
      }),
    },
  });

describe("Computer HTTPS route contract", () => {
  test("requires a verified User bearer token", async () => {
    const response = await handler().handleRequest(
      request(
        "workspace",
        encodeWorkspaceGetRequest({ protocolMajor: 1, requestId: "r", workspaceSlug: "alpha" }),
        "daemon-token",
      ),
      WORKSPACE_GET_METHOD,
    );
    expect(await response.json()).toEqual({
      error: { code: 401, message: "authentication required" },
    });
  });

  test("rejects malformed request bodies", async () => {
    const malformed = new Request("https://server.example/api/computer/workspace", {
      method: "POST",
      headers: { authorization: "Bearer user-token" },
      body: "{",
    });
    expect(await (await handler().handleRequest(malformed, WORKSPACE_GET_METHOD)).json()).toEqual({
      error: { code: 400, message: "invalid RPC request" },
    });
  });

  test("returns the existing protobuf result envelope for workspace:get", async () => {
    const response = await handler().handleRequest(
      request(
        "workspace",
        encodeWorkspaceGetRequest({
          protocolMajor: 1,
          requestId: "request-1",
          workspaceSlug: "alpha",
        }),
      ),
      WORKSPACE_GET_METHOD,
    );
    const body = (await response.json()) as { result: { b64data: string } };
    expect(
      decodeWorkspaceGetResponse(Uint8Array.from(Buffer.from(body.result.b64data, "base64"))),
    ).toEqual({
      protocolMajor: 1,
      requestId: "request-1",
      workspace: { id: "workspace-1", slug: "alpha", name: "Alpha" },
    });
  });

  test("maps computer:register through the authenticated registrar", async () => {
    const response = await handler().handleRequest(
      request(
        "attach",
        encodeComputerRegisterRequest({
          protocolMajor: 1,
          requestId: "register-1",
          workspaceSlug: "alpha",
          machineId: "machine-1",
          name: "host",
          displayName: "Host",
          platform: "linux",
          osVersion: "1",
          computerVersion: "1",
          registrationIdempotencyKey: "stable-retry-key",
        }),
      ),
      COMPUTER_REGISTER_METHOD,
    );
    const body = (await response.json()) as { result: { b64data: string } };
    expect(
      decodeComputerRegisterResponse(Uint8Array.from(Buffer.from(body.result.b64data, "base64"))),
    ).toMatchObject({
      requestId: "register-1",
      computerId: "computer-1",
      workspaceId: "workspace-1",
      daemonApiKey: "daemon-key",
    });
  });

  test("a body method cannot override the route operation", async () => {
    const payload = encodeWorkspaceGetRequest({
      protocolMajor: 1,
      requestId: "request-override",
      workspaceSlug: "alpha",
    });
    const overridden = new Request("https://server.example/api/computer/workspace", {
      method: "POST",
      headers: { authorization: "Bearer user-token", "content-type": "application/json" },
      body: JSON.stringify({
        method: COMPUTER_REGISTER_METHOD,
        b64data: Buffer.from(payload).toString("base64"),
      }),
    });
    const response = await handler().handleRequest(overridden, WORKSPACE_GET_METHOD);
    const body = (await response.json()) as { result: { b64data: string } };
    expect(
      decodeWorkspaceGetResponse(Uint8Array.from(Buffer.from(body.result.b64data, "base64"))),
    ).toMatchObject({ requestId: "request-override", workspace: { id: "workspace-1" } });
  });
});
