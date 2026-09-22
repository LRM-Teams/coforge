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
    contentType: "",
    contentBase64: "",
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

test("Workspace File read carries a previewable image's bytes and sniffed media type", () => {
  // A real 1x1 PNG, so the bytes are a payload rather than an arbitrary run of bytes.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  const result = {
    ...readRequest,
    status: "ok" as const,
    sizeBytes: png.length,
    modifiedAtMs: 1_700_000_000_000,
    text: "",
    contentType: "image/png",
    contentBase64: png.toString("base64"),
  };
  expect(decodeAgentWorkspaceFileReadResult(encodeAgentWorkspaceFileReadResult(result))).toEqual(
    result,
  );
  // The bytes are one payload, not two: a result may not claim both a text body and an image.
  expect(() => encodeAgentWorkspaceFileReadResult({ ...result, text: "not an image" })).toThrow();
  // A media type with no bytes behind it, and bytes with no media type to name them, are both
  // unrepresentable: an image read always fills both, and a text read fills neither.
  expect(() => encodeAgentWorkspaceFileReadResult({ ...result, contentBase64: "" })).toThrow();
  expect(() => encodeAgentWorkspaceFileReadResult({ ...result, contentType: "" })).toThrow();
  expect(() => encodeAgentWorkspaceFileReadResult({ ...result, contentType: "png" })).toThrow();
  expect(() =>
    encodeAgentWorkspaceFileReadResult({ ...result, contentBase64: "not base64!" }),
  ).toThrow();
  // Over the payload bound, refused before anything is allocated.
  const oversized = Buffer.alloc(1024 * 1024 + 1);
  expect(() =>
    encodeAgentWorkspaceFileReadResult({ ...result, contentBase64: oversized.toString("base64") }),
  ).toThrow();
});
