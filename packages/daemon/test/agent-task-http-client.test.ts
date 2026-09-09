import { expect, test } from "bun:test";
import { encodeTaskResponse } from "@coforge/protocol";
import { defaultAgentTaskHttpClient } from "../src/connection/daemon-connection";

const request = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  operation: "list",
  target: "#general",
} as const;

test("Agent Task HTTP client rejects a response for a different request", async () => {
  const bytes = encodeTaskResponse({
    protocolMajor: 1,
    requestId: "request-2",
    tasks: [],
  });
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ result: { b64data: bytes.toBase64() } });
    },
  });
  try {
    await expect(
      defaultAgentTaskHttpClient.request({
        url: `${server.url}api/agent-messages`,
        agentApiKey: "agent-key",
        daemonApiKey: "daemon-key",
        request,
      }),
    ).rejects.toThrow("Task response request ID does not match request");
  } finally {
    await server.stop();
  }
});

test("Agent Task HTTP client reports an authorization denial without treating it as transport", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ error: { code: 403, message: "details must not be exposed" } });
    },
  });
  try {
    await expect(
      defaultAgentTaskHttpClient.request({
        url: `${server.url}api/agent-messages`,
        agentApiKey: "agent-key",
        daemonApiKey: "daemon-key",
        request,
      }),
    ).rejects.toThrow("Agent Task access denied");
  } finally {
    await server.stop();
  }
});

test("Agent Task HTTP client abandons a server request at its deadline", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      return await new Promise<Response>(() => {});
    },
  });
  try {
    await expect(
      defaultAgentTaskHttpClient.request({
        url: `${server.url}api/agent-messages`,
        agentApiKey: "agent-key",
        daemonApiKey: "daemon-key",
        request,
      }),
    ).rejects.toBeInstanceOf(Error);
  } finally {
    await server.stop(true);
  }
}, 11_000);
