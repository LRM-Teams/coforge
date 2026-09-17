import { expect, test } from "bun:test";
import {
  classifyAgentProxyFailure,
  AGENT_PROXY_CORRELATION_HEADER,
  type AgentProxyFailureClass,
} from "../src/agent-proxy-failure";
import { AgentTransportError } from "../src/connection/agent-transport-error";
import { AgentPreflightError } from "../src/daemon-runtime/agent-preflight-error";
import { AgentMessageRequestError } from "../src/connection/agent-message-request-error";

const context = {
  method: "POST",
  path: "/api/agent/v1/local/messages",
  routeFamily: "agent-api/send",
  agentId: "agent-a",
};

test("classifies each AgentTransportError failure class with its own status and fields", () => {
  const cases: Array<{
    error: AgentTransportError;
    status: number;
    failureClass: AgentProxyFailureClass;
  }> = [
    {
      error: AgentTransportError.preResponseTransport("agent send", new TypeError("fetch failed")),
      status: 502,
      failureClass: "pre_response_transport",
    },
    {
      error: AgentTransportError.upstreamHttpResponse("agent send", 500),
      status: 500,
      failureClass: "upstream_http_response",
    },
    {
      error: AgentTransportError.midResponseTransport("agent send", 200, new Error("stream reset")),
      status: 502,
      failureClass: "mid_response_transport",
    },
    {
      error: AgentTransportError.protocolMismatch("agent send", 200, "response is missing state"),
      status: 502,
      failureClass: "protocol_mismatch",
    },
  ];
  for (const { error, status, failureClass } of cases) {
    const classified = classifyAgentProxyFailure(error, context);
    expect(classified.status).toBe(status);
    expect(classified.body.proxy.failure_class).toBe(failureClass);
    expect(classified.body.proxy.layer).toBe("local_daemon_proxy");
    expect(classified.body.proxy.route_family).toBe("agent-api/send");
    expect(classified.body.proxy.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(classified.body.code).toBe("agent_proxy_failed");
    expect(classified.logFields.correlation).toBe(classified.body.proxy.correlation_id);
    expect(classified.logFields.failure_class).toBe(failureClass);
  }
});

test("upstream_http_response passes the real status through; the others fall back to 502", () => {
  const passthrough = classifyAgentProxyFailure(
    AgentTransportError.upstreamHttpResponse("agent send", 429),
    context,
  );
  expect(passthrough.status).toBe(429);
  expect(passthrough.body.proxy.upstream_status).toBe(429);
});

test("a local precondition is its own 400 class, never confused with a transport failure", () => {
  const classified = classifyAgentProxyFailure(
    new AgentPreflightError("Agent API key is missing", "AGENT_API_KEY_MISSING"),
    context,
  );
  expect(classified.status).toBe(400);
  expect(classified.body.error).toBe("Agent API key is missing");
  expect(classified.body.code).toBe("AGENT_API_KEY_MISSING");
  expect(classified.body.proxy.failure_class).toBe("local_precondition");
  expect(classified.body.proxy.response_started).toBe(false);
  expect(classified.body.proxy.draft_saved).toBeUndefined();
});

test("a preflight error that saved a draft (e.g. the --target-confirmed guard) carries draft_saved: true", () => {
  const classified = classifyAgentProxyFailure(
    new AgentPreflightError(
      "Possible thread target mismatch",
      "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED",
      true,
    ),
    context,
  );
  expect(classified.status).toBe(400);
  expect(classified.body.proxy.failure_class).toBe("local_precondition");
  expect(classified.body.proxy.draft_saved).toBe(true);
});

test("a known-safe validation error passes its message through as its own failure class", () => {
  const classified = classifyAgentProxyFailure(
    AgentMessageRequestError.fromRpc(400, "mute requires a channel target"),
    context,
  );
  expect(classified.status).toBe(400);
  expect(classified.body.error).toBe("mute requires a channel target");
  expect(classified.body.proxy.failure_class).toBe("request_validation");
});

test("reviewer isolation withholds detail regardless of the underlying failure", () => {
  const classified = classifyAgentProxyFailure(
    AgentMessageRequestError.fromRpc(400, "sensitive detail"),
    { ...context, redact: true },
  );
  expect(classified.status).toBe(502);
  expect(classified.body.detail).toBeUndefined();
  expect(JSON.stringify(classified.body)).not.toContain("sensitive detail");
});

test("every classified failure carries a response header name for the correlation id", () => {
  expect(AGENT_PROXY_CORRELATION_HEADER).toBe("x-coforge-correlation-id");
});

test("a wholly unrecognised thrown value is still classified, never a bare 502 with no body", () => {
  const classified = classifyAgentProxyFailure(new Error("something unexpected"), context);
  expect(classified.status).toBe(502);
  expect(classified.body.proxy.failure_class).toBe("unclassified");
  expect(classified.body.proxy.correlation_id).toBeTruthy();
  expect(classified.body.detail).toContain("something unexpected");
});

test("a bounded, whitespace-normalised detail never grows past 500 characters", () => {
  const longMessage = `line one\n\n${"x".repeat(600)}`;
  const classified = classifyAgentProxyFailure(
    AgentTransportError.protocolMismatch("agent send", 200, longMessage),
    context,
  );
  expect(classified.body.detail?.length).toBeLessThanOrEqual(501);
  expect(classified.body.detail).not.toContain("\n");
});

test("an unclassified failure logs its bounded detail, and a reviewer-isolated one does not", () => {
  const classified = classifyAgentProxyFailure(new Error("Agent API key is  missing"), context);
  expect(classified.body.proxy.cause_code).toBe("UNCLASSIFIED_PROXY_FAILURE");
  expect(classified.logFields.detail).toBe("Agent API key is missing");

  const redacted = classifyAgentProxyFailure(new Error("secret upstream text"), {
    ...context,
    redact: true,
  });
  expect(redacted.logFields.detail).toBeUndefined();
});
