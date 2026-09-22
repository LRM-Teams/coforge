import { afterEach, expect, spyOn, test } from "bun:test";
import {
  agentApiRoutes,
  CAUSAL_OPENVIKING_TOOL_PROFILE,
  CAUSAL_TOOL_PROFILE,
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_TOOL_PROFILE,
  isOpenVikingAgentError,
  type OpenVikingAgentError,
} from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "../src/agent-proxy";
import {
  admitOpenVikingRead,
  forwardOpenVikingRead,
  OpenVikingReadProxyError,
} from "../src/openviking-read-proxy";
import {
  DaemonConnection,
  type CentrifugeWorkspaceClient,
} from "../src/connection/daemon-connection";

const proxies: Array<{ close(): void }> = [];
const servers: Array<{ stop(close?: boolean): void }> = [];
const fetchSpies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
  for (const server of servers.splice(0)) server.stop(true);
  for (const spy of fetchSpies.splice(0)) spy.mockRestore();
});

const AGENT_API_KEY = `sk_agent_${"a".repeat(43)}`;
const FIND_COMMAND = {
  protocol: OPENVIKING_AGENT_PROTOCOL,
  op: "find" as const,
  operationId: "deploy-runbook",
  query: "deploy rollback",
};

function openvikingUrl(proxyUrl: string): string {
  return proxyUrl.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.openviking.path);
}

function startOpenVikingProxy(input?: {
  fence?: string;
  handler?: (context: string, command: unknown, agentApiKey: string) => Promise<unknown> | unknown;
}) {
  const calls: Array<{ context: string; command: unknown; agentApiKey: string }> = [];
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      memoryFence: () => input?.fence,
      agentOpenviking: async (context, command, agentApiKey) => {
        calls.push({ context, command, agentApiKey });
        if (input?.handler) return input.handler(context, command, agentApiKey);
        return {
          protocol: OPENVIKING_AGENT_PROTOCOL,
          op: command.op,
          operationId: command.operationId,
          duplicate: false,
          items: [{ kind: "openviking", citationId: "ov:wiki/deploy" }],
        };
      },
    },
  });
  proxies.push(proxy);
  return { proxy, calls, token: proxy.issue("agent-a", AGENT_API_KEY) };
}

async function postOpenViking(
  proxyUrl: string,
  token: string | undefined,
  body: unknown,
  init?: { method?: string; contentType?: string },
) {
  const method = init?.method ?? agentApiRoutes.proxy.openviking.method;
  return fetch(openvikingUrl(proxyUrl), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === "GET" || method === "HEAD"
        ? {}
        : { "content-type": init?.contentType ?? "application/json" }),
    },
    ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify(body) }),
  });
}

test("admitOpenVikingRead accepts a fenced find and rejects malformed, mutation, and profile mismatch", () => {
  expect(admitOpenVikingRead({ body: FIND_COMMAND, fence: OPENVIKING_TOOL_PROFILE })).toEqual({
    ok: true,
    command: FIND_COMMAND,
  });
  expect(
    admitOpenVikingRead({
      body: { ...FIND_COMMAND, op: "search_context" },
      fence: CAUSAL_OPENVIKING_TOOL_PROFILE,
    }).ok,
  ).toBe(true);

  const malformed = admitOpenVikingRead({
    body: { op: "find" },
    fence: OPENVIKING_TOOL_PROFILE,
  });
  expect(malformed).toMatchObject({
    ok: false,
    status: 400,
    body: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      error: { code: "openviking-request-invalid" },
    },
  });

  const mutation = admitOpenVikingRead({
    body: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-1",
      conversationId: "conv-1",
      targetAgentId: "agent-b",
      recipientRationale: "share the runbook",
      citationRefs: ["ov:wiki/deploy"],
      body: "see deploy rollback",
    },
    fence: OPENVIKING_TOOL_PROFILE,
  });
  expect(mutation).toMatchObject({
    ok: false,
    status: 400,
    body: {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      operationId: "offer-1",
      error: { code: "openviking-request-invalid" },
    },
  });

  for (const fence of [undefined, CAUSAL_TOOL_PROFILE, "openviking", "causal_openviking", "off"]) {
    const denied = admitOpenVikingRead({ body: FIND_COMMAND, fence });
    expect(denied, `fence:${String(fence)}`).toMatchObject({
      ok: false,
      status: 403,
      body: {
        protocol: OPENVIKING_AGENT_PROTOCOL,
        operationId: "deploy-runbook",
        error: { code: "openviking-unauthorized" },
      },
    });
  }
});

test("the OpenViking read proxy fail-closed matrix: malformed, wrong path/method, token, profile, mutation", async () => {
  const { proxy, calls, token } = startOpenVikingProxy({ fence: OPENVIKING_TOOL_PROFILE });

  const malformed = await postOpenViking(proxy.url, token, { op: "find" });
  expect(malformed.status).toBe(400);
  const malformedBody = (await malformed.json()) as OpenVikingAgentError;
  expect(isOpenVikingAgentError(malformedBody)).toBe(true);
  expect(malformedBody.error.code).toBe("openviking-request-invalid");

  const wrongMethod = await postOpenViking(proxy.url, token, FIND_COMMAND, { method: "GET" });
  expect(wrongMethod.status).toBe(404);
  expect(await wrongMethod.text()).toBe("not found");

  const wrongPath = await fetch(`${new URL(proxy.url).origin}/api/agent/v1/openviking/write`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(FIND_COMMAND),
  });
  expect(wrongPath.status).toBe(404);

  const missingToken = await postOpenViking(proxy.url, undefined, FIND_COMMAND);
  expect(missingToken.status).toBe(401);
  expect(await missingToken.text()).toBe("unauthorized");

  const forged = await postOpenViking(proxy.url, `sfp_${"a".repeat(43)}`, FIND_COMMAND);
  expect(forged.status).toBe(401);

  proxy.revoke(token);
  const revoked = await postOpenViking(proxy.url, token, FIND_COMMAND);
  expect(revoked.status).toBe(401);
  expect(calls).toHaveLength(0);

  const mismatch = startOpenVikingProxy({ fence: CAUSAL_TOOL_PROFILE });
  const mismatchResponse = await postOpenViking(mismatch.proxy.url, mismatch.token, FIND_COMMAND);
  expect(mismatchResponse.status).toBe(403);
  const mismatchBody = (await mismatchResponse.json()) as OpenVikingAgentError;
  expect(mismatchBody).toMatchObject({
    protocol: OPENVIKING_AGENT_PROTOCOL,
    operationId: "deploy-runbook",
    error: { code: "openviking-unauthorized" },
  });
  expect(mismatch.calls).toHaveLength(0);

  const mutating = startOpenVikingProxy({ fence: OPENVIKING_TOOL_PROFILE });
  for (const body of [
    {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "offer",
      operationId: "offer-1",
      conversationId: "conv-1",
      targetAgentId: "agent-b",
      recipientRationale: "share the runbook",
      citationRefs: ["ov:wiki/deploy"],
      body: "see deploy rollback",
    },
    {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "write",
      operationId: "write-1",
      query: "create a skill",
    },
    {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "commit",
      operationId: "commit-1",
      uri: "viking://workspace-1/docs/deploy.md",
    },
  ]) {
    const rejected = await postOpenViking(mutating.proxy.url, mutating.token, body);
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as OpenVikingAgentError).error.code).toBe(
      "openviking-request-invalid",
    );
  }
  expect(mutating.calls).toHaveLength(0);
});

test("a valid OpenViking read preserves the stable operation ID and token-bound identity", async () => {
  const { proxy, calls, token } = startOpenVikingProxy({
    fence: CAUSAL_OPENVIKING_TOOL_PROFILE,
  });
  const response = await postOpenViking(proxy.url, token, {
    ...FIND_COMMAND,
    tenantToken: "ov-secret",
    apiKey: "leaked",
    fence: OPENVIKING_TOOL_PROFILE,
    agentId: "forged-agent",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "find",
    operationId: "deploy-runbook",
    duplicate: false,
    items: [{ kind: "openviking", citationId: "ov:wiki/deploy" }],
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.agentApiKey).toBe(AGENT_API_KEY);
  expect(calls[0]?.command).toEqual(FIND_COMMAND);
  expect(JSON.stringify(calls[0]?.command)).not.toContain("ov-secret");
  expect(JSON.stringify(calls[0]?.command)).not.toContain("leaked");
  expect(JSON.stringify(calls[0]?.command)).not.toContain("forged-agent");
});

test("the OpenViking read proxy 404s when the runtime has no handler", async () => {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      memoryFence: () => OPENVIKING_TOOL_PROFILE,
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", AGENT_API_KEY);
  const response = await postOpenViking(proxy.url, token, FIND_COMMAND);
  expect(response.status).toBe(404);
});

test("forwardOpenVikingRead posts the command to the injected URL without OV credentials", async () => {
  const seen: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.push({
        url: new URL(request.url).pathname,
        headers: request.headers,
        body: await request.json(),
      });
      return Response.json({
        protocol: OPENVIKING_AGENT_PROTOCOL,
        op: "find",
        operationId: "deploy-runbook",
        duplicate: false,
        items: [{ kind: "not-decoded", excerpt: "daemon must not interpret citations" }],
      });
    },
  });
  servers.push(server);

  const body = await forwardOpenVikingRead({
    url: `http://127.0.0.1:${server.port}${agentApiRoutes.cloud.openviking.path}`,
    command: FIND_COMMAND,
    agentApiKey: AGENT_API_KEY,
    daemonApiKey: "daemon-token",
  });

  expect(body).toEqual({
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "find",
    operationId: "deploy-runbook",
    duplicate: false,
    items: [{ kind: "not-decoded", excerpt: "daemon must not interpret citations" }],
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe(agentApiRoutes.cloud.openviking.path);
  expect(seen[0]?.headers.get("authorization")).toBe("Bearer daemon-token");
  expect(seen[0]?.headers.get("x-coforge-agent-api-key")).toBe(`Bearer ${AGENT_API_KEY}`);
  expect(seen[0]?.headers.get("x-openviking-account")).toBeNull();
  expect(seen[0]?.headers.get("x-openviking-user")).toBeNull();
  expect(seen[0]?.body).toEqual(FIND_COMMAND);
  expect(JSON.stringify(seen[0]?.body)).not.toContain("ov-secret");
});

test("forwardOpenVikingRead fail-closes a credential leak and an operationId rewrite", async () => {
  await expect(
    forwardOpenVikingRead({
      url: "https://web.example/api/agent/v1/openviking",
      command: FIND_COMMAND,
      agentApiKey: AGENT_API_KEY,
      daemonApiKey: "daemon-token",
      fetch: async () =>
        Response.json({
          protocol: OPENVIKING_AGENT_PROTOCOL,
          op: "find",
          operationId: "deploy-runbook",
          duplicate: false,
          apiKey: "ov-runtime-secret",
          items: [],
        }),
    }),
  ).rejects.toMatchObject({
    name: "OpenVikingReadProxyError",
    status: 502,
    body: { error: { code: "openviking-runtime-unavailable" } },
  });

  await expect(
    forwardOpenVikingRead({
      url: "https://web.example/api/agent/v1/openviking",
      command: FIND_COMMAND,
      agentApiKey: AGENT_API_KEY,
      daemonApiKey: "daemon-token",
      fetch: async () =>
        Response.json({
          protocol: OPENVIKING_AGENT_PROTOCOL,
          op: "find",
          operationId: "rewritten-id",
          duplicate: false,
          items: [],
        }),
    }),
  ).rejects.toBeInstanceOf(OpenVikingReadProxyError);
});

test("forwardOpenVikingRead passes through a sanitized web error and maps transport failure", async () => {
  try {
    await forwardOpenVikingRead({
      url: "https://web.example/api/agent/v1/openviking",
      command: FIND_COMMAND,
      agentApiKey: AGENT_API_KEY,
      daemonApiKey: "daemon-token",
      fetch: async () =>
        Response.json(
          {
            protocol: OPENVIKING_AGENT_PROTOCOL,
            operationId: "deploy-runbook",
            error: { code: "openviking-unauthorized", message: "profile is not ready" },
          },
          { status: 403 },
        ),
    });
    throw new Error("expected sanitized web error");
  } catch (error) {
    expect(error).toBeInstanceOf(OpenVikingReadProxyError);
    expect(error).toMatchObject({
      status: 403,
      body: {
        protocol: OPENVIKING_AGENT_PROTOCOL,
        operationId: "deploy-runbook",
        error: { code: "openviking-unauthorized", message: "profile is not ready" },
      },
    });
  }

  try {
    await forwardOpenVikingRead({
      url: "https://web.example/api/agent/v1/openviking",
      command: FIND_COMMAND,
      agentApiKey: AGENT_API_KEY,
      daemonApiKey: "daemon-token",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    throw new Error("expected transport failure");
  } catch (error) {
    expect(error).toBeInstanceOf(OpenVikingReadProxyError);
    expect((error as OpenVikingReadProxyError).body.error.code).toBe(
      "openviking-runtime-unavailable",
    );
  }
});

test("the runtime forward posts to the configured web OpenViking route", async () => {
  const fake = fakeCentrifugeClient();
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "find",
      operationId: "deploy-runbook",
      duplicate: false,
      items: [],
    }),
  );
  const transport = new DaemonConnection("wss://cloud.example", () => fake.client);
  await transport.start("daemon-token", {
    computerId: "computer-a",
    workspaceId: "workspace-a",
    serverHttpUrl: "https://server.example/api/internal/centrifugo",
  });
  await expect(transport.agentOpenviking(FIND_COMMAND, AGENT_API_KEY)).resolves.toEqual({
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "find",
    operationId: "deploy-runbook",
    duplicate: false,
    items: [],
  });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0] ?? [];
  expect(String(url)).toBe("https://server.example/api/agent/v1/openviking");
  expect(init?.headers).toMatchObject({
    authorization: "Bearer daemon-token",
    "x-coforge-agent-api-key": `Bearer ${AGENT_API_KEY}`,
  });
  expect(JSON.parse(String(init?.body))).toEqual(FIND_COMMAND);
  fetchSpies.push(fetchSpy);
  await transport.stop();
});

function fakeCentrifugeClient() {
  let connected = () => {};
  const client: CentrifugeWorkspaceClient = {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
    },
    connect() {
      connected();
    },
    disconnect() {},
    rpc: async () => new Uint8Array(),
  };
  return { client };
}
