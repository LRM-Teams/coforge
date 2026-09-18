import { expect, test } from "bun:test";
import {
  encodeAgentWorkspaceFilesListRequest,
  decodeAgentWorkspaceFilesListRequest,
  encodeAgentWorkspaceFilesListResult,
  decodeAgentWorkspaceFilesListResult,
  encodeAgentWorkspaceFileReadRequest,
  decodeAgentWorkspaceFileReadRequest,
  encodeAgentWorkspaceFileReadResult,
  decodeAgentWorkspaceFileReadResult,
} from "./agent-workspace-files";

const listRequest = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  dirPath: "src/lib",
  includeHidden: false,
};

test("Workspace Files list keeps request scope and entries on the wire", () => {
  expect(
    decodeAgentWorkspaceFilesListRequest(encodeAgentWorkspaceFilesListRequest(listRequest)),
  ).toEqual(listRequest);
  const result = {
    ...listRequest,
    status: "ok" as const,
    rootPath: "/workspaces/workspace-1/agents/agent-1/src/lib",
    entries: [
      { name: "index.ts", type: "file" as const, sizeBytes: 128, modifiedAtMs: 1_700_000_000_000 },
      { name: "nested", type: "dir" as const, sizeBytes: 0, modifiedAtMs: 1_700_000_000_000 },
    ],
  };
  expect(decodeAgentWorkspaceFilesListResult(encodeAgentWorkspaceFilesListResult(result))).toEqual(
    result,
  );
  expect(() =>
    decodeAgentWorkspaceFilesListRequest(encodeAgentWorkspaceFilesListResult(result)),
  ).toThrow();
  expect(() =>
    encodeAgentWorkspaceFilesListRequest({ ...listRequest, protocolMajor: 2 }),
  ).toThrow();
  expect(() =>
    encodeAgentWorkspaceFilesListRequest({ ...listRequest, dirPath: "../escape" }),
  ).toThrow();
  expect(() =>
    encodeAgentWorkspaceFilesListRequest({ ...listRequest, dirPath: "/absolute" }),
  ).toThrow();
  expect(() =>
    encodeAgentWorkspaceFilesListRequest({ ...listRequest, agentId: "../other" }),
  ).toThrow();
});

const readRequest = {
  protocolMajor: 1,
  requestId: "request-2",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  path: "src/lib/index.ts",
};

test("Workspace File read keeps request scope and text on the wire", () => {
  expect(
    decodeAgentWorkspaceFileReadRequest(encodeAgentWorkspaceFileReadRequest(readRequest)),
  ).toEqual(readRequest);
  const result = {
    ...readRequest,
    status: "ok" as const,
    sizeBytes: 42,
    modifiedAtMs: 1_700_000_000_000,
    text: "export const answer = 42;\n",
  };
  expect(decodeAgentWorkspaceFileReadResult(encodeAgentWorkspaceFileReadResult(result))).toEqual(
    result,
  );
  expect(() =>
    encodeAgentWorkspaceFileReadRequest({ ...readRequest, path: "../secret" }),
  ).toThrow();
  expect(() =>
    encodeAgentWorkspaceFileReadResult({ ...result, status: "bogus" as never }),
  ).toThrow();
  expect(() =>
    encodeAgentWorkspaceFileReadResult({ ...result, text: "x".repeat(600 * 1024) }),
  ).toThrow();
});
