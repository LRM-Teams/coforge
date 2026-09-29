import { expect, test } from "bun:test";
import {
  classifyAgentProxyFailure,
  AGENT_PROXY_CORRELATION_HEADER,
  type AgentProxyFailureClass,
} from "#src/agent-proxy-failure";
import { AgentTransportError } from "#src/connection/agent-transport-error";
import { AgentPreflightError } from "#src/daemon-runtime/agent-preflight-error";
import { AgentSendVerdictError } from "#src/daemon-runtime/agent-send-verdict";
import { AgentMessageRequestError } from "#src/connection/agent-message-request-error";
import { AgentUpstreamRefusalError } from "#src/connection/agent-upstream-refusal-error";
import { AgentExplainedRefusalError } from "#src/connection/agent-explained-refusal-error";

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
      { draftSaved: true },
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

test("credentials never ride along in the detail that is returned and logged", () => {
  const key = `sk_agent_${"a".repeat(43)}`;
  const classified = classifyAgentProxyFailure(
    new Error(`upstream rejected ${key} sent as Bearer sfp_${"b".repeat(43)}`),
    context,
  );
  expect(classified.logFields.detail).toBe("upstream rejected [redacted] sent as [redacted]");
  expect(JSON.stringify(classified.body)).not.toContain(key);
});

test("an unclassifiable upstream refusal logs the server's code, and publishes none of it", () => {
  const classified = classifyAgentProxyFailure(
    new AgentUpstreamRefusalError("server Agent Task request failed (400)", "ACCESS_DENIED"),
    { ...context, path: "/api/agent/v1/tasks", routeFamily: "agent-api/task" },
  );

  // Log-only: the daemon operator can see *why* the server refused…
  expect(classified.logFields.upstream_code).toBe("ACCESS_DENIED");
  // …while the caller's body carries the correlation id and nothing about the upstream's internals.
  expect(JSON.stringify(classified.body)).not.toContain("ACCESS_DENIED");
  expect(classified.body.proxy.cause_code).toBe("UNCLASSIFIED_PROXY_FAILURE");
});

test("a business refusal reaches the caller as its own status and code, not an opaque 502", () => {
  const classified = classifyAgentProxyFailure(
    new AgentUpstreamRefusalError("server Agent Task request failed (409)", "CONFLICT", 409),
    { ...context, path: "/api/agent/v1/tasks", routeFamily: "agent-api/task" },
  );
  expect(classified.status).toBe(409);
  expect(classified.body.code).toBe("CONFLICT");
  expect(classified.body.proxy.cause_code).toBe("CONFLICT");
  expect(classified.body.proxy.failure_class).toBe("upstream_http_response");
  expect(classified.body.proxy.upstream_status).toBe(409);
  expect(classified.body.error).toContain("changed since");
});

test("reviewer isolation withholds the refusal entirely, mapped or not", () => {
  const redacted = classifyAgentProxyFailure(
    new AgentUpstreamRefusalError("server Agent Task request failed (409)", "CONFLICT", 409),
    { ...context, path: "/api/agent/v1/tasks", routeFamily: "agent-api/task", redact: true },
  );
  expect(redacted.status).toBe(502);
  expect(redacted.body.proxy.cause_code).toBe("REVIEWER_ISOLATION_WITHHELD");
  expect(JSON.stringify(redacted.body)).not.toContain("CONFLICT");
});

test("a refusal status outside the business set stays opaque", () => {
  const classified = classifyAgentProxyFailure(
    new AgentUpstreamRefusalError("server Agent Task request failed (500)", "INTERNAL_ERROR", 500),
    context,
  );
  expect(classified.status).toBe(502);
  expect(classified.body.proxy.cause_code).toBe("UNCLASSIFIED_PROXY_FAILURE");
});

test("a send precondition carries its verdict, and its code-specific details", () => {
  const classified = classifyAgentProxyFailure(
    new AgentPreflightError(
      "The saved draft for this target expired",
      "SEND_DRAFT_EXPIRED",
      { draftSaved: false, retryable: false, suggestedNextAction: "Read @ada before resending." },
      { discarded_draft: { content: "stale reply", saved_at: "2026-09-28T00:00:00.000Z" } },
    ),
    context,
  );
  expect(classified.status).toBe(400);
  expect(classified.body).toMatchObject({
    code: "SEND_DRAFT_EXPIRED",
    retryable: false,
    suggested_next_action: "Read @ada before resending.",
    details: { discarded_draft: { content: "stale reply", saved_at: "2026-09-28T00:00:00.000Z" } },
    proxy: { failure_class: "local_precondition", draft_saved: false },
  });
});

test("a judged send failure is classified by its cause, then carries the daemon's verdict", () => {
  const judged = new AgentSendVerdictError(
    "replay failed",
    AgentTransportError.preResponseTransport("agent send", new TypeError("fetch failed")),
    { retryable: true, draftSaved: true, suggestedNextAction: "retry with the same key" },
  );
  const classified = classifyAgentProxyFailure(judged, context);
  expect(classified.status).toBe(502);
  expect(classified.body).toMatchObject({
    retryable: true,
    suggested_next_action: "retry with the same key",
    proxy: { failure_class: "pre_response_transport", draft_saved: true },
  });

  // Reviewer isolation withholds the upstream detail, never the verdict.
  const redacted = classifyAgentProxyFailure(
    new AgentSendVerdictError(
      "replay failed",
      AgentTransportError.upstreamHttpResponse("agent send", 503),
      { retryable: false, draftSaved: false, suggestedNextAction: "CANNOT_CONFIRM" },
    ),
    { ...context, redact: true },
  );
  expect(redacted.body).toMatchObject({
    retryable: false,
    suggested_next_action: "CANNOT_CONFIRM",
    proxy: { cause_code: "REVIEWER_ISOLATION_WITHHELD", draft_saved: false },
  });
  expect(redacted.body.proxy.upstream_status).toBeUndefined();
});

const explainedRefusal = (status: number, body: unknown) =>
  AgentExplainedRefusalError.fromResponse(status, JSON.stringify(body))!;

test("an explained refusal reaches the caller with its status, reason, code and retryability", () => {
  const classified = classifyAgentProxyFailure(
    explainedRefusal(403, {
      error:
        "@bob is not a member of this Workspace, so this Agent cannot send them a direct message",
      code: "DM_PEER_NOT_IN_WORKSPACE",
      retryable: false,
    }),
    context,
  );
  expect(classified.status).toBe(403);
  expect(classified.body).toMatchObject({
    error:
      "@bob is not a member of this Workspace, so this Agent cannot send them a direct message",
    code: "DM_PEER_NOT_IN_WORKSPACE",
    retryable: false,
    proxy: {
      failure_class: "upstream_refusal",
      cause_code: "DM_PEER_NOT_IN_WORKSPACE",
      upstream_status: 403,
      response_started: true,
      response_complete: true,
    },
  });
});

test("an explained refusal without a code carries its reason and names no upstream code", () => {
  const classified = classifyAgentProxyFailure(
    explainedRefusal(403, { error: "target is not accessible" }),
    context,
  );
  expect(classified.status).toBe(403);
  expect(classified.body.error).toBe("target is not accessible");
  expect(classified.body.proxy.failure_class).toBe("upstream_refusal");
  expect(classified.body.code).toBeUndefined();
  expect(classified.body.proxy.cause_code).toBe("HTTP_403");
  expect(classified.body.retryable).toBeUndefined();
});

test("an explained refusal's reason is bounded and never carries a credential", () => {
  const classified = classifyAgentProxyFailure(
    explainedRefusal(403, { error: `refused sk_agent_${"a".repeat(24)} ${"x".repeat(600)}` }),
    context,
  );
  expect(classified.body.error).not.toContain("sk_agent_");
  expect(classified.body.error.length).toBeLessThanOrEqual(501);
});

test("reviewer isolation withholds an explained refusal too", () => {
  const classified = classifyAgentProxyFailure(
    explainedRefusal(403, { error: "sensitive reason", code: "DM_PEER_NOT_IN_WORKSPACE" }),
    { ...context, redact: true },
  );
  expect(classified.status).toBe(502);
  expect(JSON.stringify(classified.body)).not.toContain("sensitive reason");
  expect(JSON.stringify(classified.body)).not.toContain("DM_PEER_NOT_IN_WORKSPACE");
});
