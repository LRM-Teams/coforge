import { expect, test } from "bun:test";
import { WORKSPACE_GET_METHOD, WORKSPACE_LIST_METHOD, WORKSPACE_PROTOCOL_MAJOR } from "./index";
import {
  decodeWorkspaceGetRequest,
  decodeWorkspaceGetResponse,
  decodeWorkspaceListRequest,
  decodeWorkspaceListResponse,
  encodeWorkspaceGetRequest,
  encodeWorkspaceGetResponse,
  encodeWorkspaceListRequest,
  encodeWorkspaceListResponse,
} from "./codec";

test("workspace:list request and response roundtrip their public fields", () => {
  const request = { protocolMajor: 1, requestId: "list-request-1" };
  const workspaces = [
    { id: "workspace-1", slug: "alpha", name: "Alpha" },
    { id: "workspace-2", slug: "beta", name: "Beta" },
  ];

  expect(decodeWorkspaceListRequest(encodeWorkspaceListRequest(request))).toMatchObject(request);
  expect(
    decodeWorkspaceListResponse(
      encodeWorkspaceListResponse({
        protocolMajor: 1,
        requestId: "list-response-1",
        workspaces,
      }),
    ),
  ).toEqual({ protocolMajor: 1, requestId: "list-response-1", workspaces });
});

test("workspace:get request and response roundtrip their public fields", () => {
  const request = { protocolMajor: 1, requestId: "get-request-1", workspaceSlug: "alpha" };
  const workspace = { id: "workspace-1", slug: "alpha", name: "Alpha" };

  expect(decodeWorkspaceGetRequest(encodeWorkspaceGetRequest(request))).toMatchObject(request);
  expect(
    decodeWorkspaceGetResponse(
      encodeWorkspaceGetResponse({ protocolMajor: 1, requestId: "get-response-1", workspace }),
    ),
  ).toEqual({ protocolMajor: 1, requestId: "get-response-1", workspace });
});

test("workspace query methods and protocol major are stable", () => {
  expect(WORKSPACE_LIST_METHOD).toBe("workspace:list");
  expect(WORKSPACE_GET_METHOD).toBe("workspace:get");
  expect(WORKSPACE_PROTOCOL_MAJOR).toBe(1);
});
