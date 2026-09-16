import { expect, test } from "bun:test";
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
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ requestId: "request-2", tasks: [] });
    },
  });
  try {
    await expect(
      defaultAgentTaskHttpClient.execute({
        url: `${server.url}api/agent/v1/tasks`,
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
      return Response.json({ error: "details must not be exposed" }, { status: 403 });
    },
  });
  try {
    await expect(
      defaultAgentTaskHttpClient.execute({
        url: `${server.url}api/agent/v1/tasks`,
        agentApiKey: "agent-key",
        daemonApiKey: "daemon-key",
        request,
      }),
    ).rejects.toThrow("server Agent Task request failed (403)");
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
      defaultAgentTaskHttpClient.execute({
        url: `${server.url}api/agent/v1/tasks`,
        agentApiKey: "agent-key",
        daemonApiKey: "daemon-key",
        request,
      }),
    ).rejects.toBeInstanceOf(Error);
  } finally {
    await server.stop(true);
  }
}, 11_000);
