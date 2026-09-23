import { expect, test } from "bun:test";
import { AgentUpstreamRefusalError } from "#src/connection/agent-upstream-refusal-error";
import { defaultAgentTaskHttpClient } from "#src/connection/daemon-connection";

const request = {
  idempotencyKey: "request-1",
  operation: "list",
  target: "#general",
} as const;

test("Agent Task HTTP client rejects a response for a different request", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ idempotencyKey: "request-2", tasks: [] });
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
    ).rejects.toThrow("Task response idempotency key does not match request");
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

test("Agent Task HTTP client keeps the server's refusal code for the daemon log only", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json(
        { error: "invalid task request", code: "ACCESS_DENIED" },
        { status: 400 },
      );
    },
  });
  try {
    const error = await defaultAgentTaskHttpClient
      .execute({
        url: `${server.url}api/agent/v1/tasks`,
        agentApiKey: "agent-key",
        daemonApiKey: "daemon-key",
        request,
      })
      .catch((thrown: unknown) => thrown);

    // The caller-facing message stays exactly what it was — a test above pins that an upstream's
    // details are not published — and the cause is carried alongside it for the log.
    expect(error).toBeInstanceOf(AgentUpstreamRefusalError);
    expect((error as AgentUpstreamRefusalError).message).toBe(
      "server Agent Task request failed (400)",
    );
    expect((error as AgentUpstreamRefusalError).upstreamCode).toBe("ACCESS_DENIED");
  } finally {
    await server.stop();
  }
});
