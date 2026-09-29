import { expect, test } from "bun:test";
import {
  createAgentMessageHttpClient,
  defaultAgentActionPrepareHttpClient,
} from "#src/connection/agent-http-clients";
import { AgentExplainedRefusalError } from "#src/connection/agent-explained-refusal-error";
import { AgentTransportError } from "#src/connection/agent-transport-error";

const keys = { agentApiKey: "agent-key", daemonApiKey: "daemon-key" };
const sendRequest = {
  idempotencyKey: "send-1",
  agentId: "agent-a",
  workspaceId: "workspace-a",
  operation: "send",
  target: "@bob",
  content: "hi",
} as const;

const departed = {
  error: "@bob is not a member of this Workspace, so this Agent cannot send them a direct message",
  code: "DM_PEER_NOT_IN_WORKSPACE",
  retryable: false,
};

function answering(status: number, body: unknown) {
  return createAgentMessageHttpClient(async () => Response.json(body, { status }));
}

async function sendFailure(status: number, body: unknown): Promise<unknown> {
  return answering(status, body).requestSend!({
    url: "https://server.test/api/agent/v1/messages",
    request: sendRequest,
    ...keys,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
}

test("a send the server refuses with a stable code reaches the daemon as that code and reason", async () => {
  const error = await sendFailure(403, departed);

  expect(error).toBeInstanceOf(AgentExplainedRefusalError);
  expect(error).toMatchObject({
    message: departed.error,
    code: "DM_PEER_NOT_IN_WORKSPACE",
    retryable: false,
    status: 403,
  });
});

test("a refusal that names no code still keeps the server's reason", async () => {
  const error = await sendFailure(403, { error: "target is not accessible" });

  expect(error).toBeInstanceOf(AgentExplainedRefusalError);
  expect(error).toMatchObject({ message: "target is not accessible", status: 403 });
  expect((error as AgentExplainedRefusalError).code).toBeUndefined();
  expect((error as AgentExplainedRefusalError).retryable).toBeUndefined();
});

test("a 5xx stays a transport failure even in the refusal shape, so the send is still reconciled", async () => {
  const error = await sendFailure(503, { error: "try later", code: "TEMPORARILY_UNAVAILABLE" });

  expect(error).toBeInstanceOf(AgentTransportError);
  expect(error).toMatchObject({ failureClass: "upstream_http_response", upstreamStatus: 503 });
});

test("a body outside the documented refusal shape is never relayed", async () => {
  for (const body of [
    { ...departed, stack: "at db.query (secret.ts:1)" },
    { error: "lowercase code", code: "dm_peer" },
    { error: 42 },
    { error: "retryable must be a boolean", retryable: "no" },
  ]) {
    const error = await sendFailure(403, body);
    expect(error).toBeInstanceOf(AgentTransportError);
    expect(error).toMatchObject({ failureClass: "upstream_http_response", upstreamStatus: 403 });
  }
});

test("an unauthorized answer is not a refusal the Agent can act on", async () => {
  const error = await sendFailure(401, { error: "unauthorized" });

  expect(error).toBeInstanceOf(AgentTransportError);
});

test("an action card the server refuses carries the same code and reason", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json(departed, { status: 403 }) });
  try {
    const error = await defaultAgentActionPrepareHttpClient
      .execute({
        url: `${server.url}api/agent/v1/actions/prepare`,
        request: { target: "@bob", action: { type: "channel:create", name: "ops" } } as never,
        ...keys,
      })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(AgentExplainedRefusalError);
    expect(error).toMatchObject({
      message: departed.error,
      code: "DM_PEER_NOT_IN_WORKSPACE",
      retryable: false,
      status: 403,
    });
  } finally {
    await server.stop();
  }
});
