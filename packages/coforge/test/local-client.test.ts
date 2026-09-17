import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { connectLocal } from "../src/local-client";
import { CliError } from "../src/cli-error";

const proxyUrl = (route: { path: string } | string) =>
  `http://proxy.test${typeof route === "string" ? route : route.path}`;

test("normalizes the message request to the registered Proxy route", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ messages: [] }));
  await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    "http://proxy.test/api/agent/v1/messages?stale=1",
  ).check();
  expect(fetch.mock.calls[0]?.[0]).toEqual(new URL("http://proxy.test/api/agent/v1/messages"));
});

afterEach(() => {
  mock.restore();
});

test("accepts sfp_ daemon-local Proxy tokens", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ requestId: "request", accepted: true, attentionCount: 0, messages: [] }),
  );

  await connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).check();

  expect(fetch).toHaveBeenCalledTimes(1);
});

test("forwards attachmentId, mentions, and targetConfirmed on a send request", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ requestId: "request", accepted: true, attentionCount: 0, messages: [] }),
  );
  const mentions = [{ type: "user" as const, id: "actor-1", name: "ada" }];

  await connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).send(
    "@ada",
    "hi @ada",
    { attachmentId: "attachment-1", mentions, targetConfirmed: true },
  );

  const [, init] = fetch.mock.calls[0]!;
  const body = JSON.parse(init!.body as string);
  expect(body.attachmentId).toBe("attachment-1");
  expect(body.mentions).toEqual(mentions);
  expect(body.targetConfirmed).toBe(true);
});

test("requests GitHub credentials through the daemon-local proxy", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      username: "x-access-token",
      password: "short-lived-token",
      expiresAt: "2026-09-16T21:00:00Z",
    }),
  );
  const credential = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  ).githubCredential!();

  expect(credential.password).toBe("short-lived-token");
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toEqual(new URL(proxyUrl(agentApiRoutes.proxy.githubCredentials.path)));
  expect(init).toMatchObject({
    method: "POST",
    headers: {
      authorization: `Bearer sfp_${"a".repeat(43)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
});

test("rejects malformed GitHub credentials from the daemon-local proxy", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      username: "x-access-token",
      password: 42,
      expiresAt: "not-a-date",
    }),
  );

  await expect(
    connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages))
      .githubCredential!(),
  ).rejects.toThrow("invalid GitHub credential response");
});

test("shows actionable validation errors returned by the Agent proxy", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("ambiguous message prefix; use the full UUID", { status: 400 }),
  );

  await expect(
    connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).read(
      "deadbeef",
    ),
  ).rejects.toThrow("ambiguous message prefix; use the full UUID");
});

test("sanitizes unknown Agent proxy error bodies", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("upstream failure included a secret", { status: 400 }),
  );

  await expect(
    connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).check(),
  ).rejects.toThrow(/^HTTP 400$/);
});

test("redacts upstream detail for a withheld reviewer-isolation send failure", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("ambiguous message prefix; use the full UUID", { status: 400 }),
  );

  await expect(
    connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).send(
      "@ada",
      "body",
      { freshnessContextMode: "withheld" },
    ),
  ).rejects.toThrow(
    "Reviewer-isolation send failed (HTTP 400); upstream error detail was withheld.",
  );
});

test("redacts upstream detail for a withheld reviewer-isolation Task failure", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("SECRET_UPSTREAM_DETAIL", { status: 400 }),
  );

  await expect(
    connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).task({
      requestId: "request",
      operation: "update",
      target: "#general",
      number: 1,
      status: "in_review",
      expectedRevision: 1,
      freshnessContextMode: "withheld",
    } as never),
  ).rejects.toThrow("reviewer-isolation Task request failed (400); upstream detail withheld");
});

test("downloads attachments through the daemon-local proxy", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("attachment bytes", {
      headers: { "content-disposition": "attachment; filename=proof.txt" },
    }),
  );
  const result = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  ).view("attachment-1");
  expect(new TextDecoder().decode(result.bytes)).toBe("attachment bytes");
  expect(fetch).toHaveBeenCalledWith(
    new URL(proxyUrl(agentApiRoutes.local.attachments.path("attachment-1"))),
    expect.any(Object),
  );
});

test("rejects legacy cf_proxy_ tokens without contacting the proxy", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));

  await expect(
    connectLocal("", `cf_proxy_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).check(),
  ).rejects.toThrow("coforge agent context is invalid");
  expect(fetch).not.toHaveBeenCalled();
});

test("posts validated reminders to the derived endpoint with implicit bearer context", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      protocolMajor: 1,
      requestId: "request",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "agent",
      accepted: true,
      reminders: [],
      events: [],
    }),
  );
  await connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).reminder(
    {
      operation: "schedule",
      title: "Check release",
      target: "#general",
      messageId: "deadbeef",
      repeat: "daily@09:30",
      timezone: "Asia/Shanghai",
    },
  );
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toEqual(new URL(proxyUrl(agentApiRoutes.proxy.reminders.path)));
  expect(init?.headers).toEqual({
    authorization: `Bearer sfp_${"a".repeat(43)}`,
    "content-type": "application/json",
  });
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({
    operation: "schedule",
    title: "Check release",
    repeat: "daily@09:30",
    timezone: "Asia/Shanghai",
  });
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.context).toBeUndefined();
});

test("resolve posts the messageId as a resolve operation", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ requestId: "request", accepted: true, attentionCount: 0, messages: [] }),
  );
  await connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).resolve(
    "abcd1234",
  );
  const [, init] = fetch.mock.calls[0]!;
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({ operation: "resolve", messageId: "abcd1234" });
});

test("a send that fails before any request was issued reports the draft as not saved", async () => {
  const fetch = spyOn(globalThis, "fetch");
  const error = await connectLocal(
    "",
    "not-a-valid-context",
    proxyUrl(agentApiRoutes.local.messages),
  )
    .send("@ada", "hi")
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  const cliError = error as CliError;
  expect(cliError.draftSaved).toBe(false);
  expect(cliError.retryable).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

test("a send that fails after the daemon reports a local precondition keeps the draft unsaved", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      {
        error: "No held draft for target: @ada",
        code: "NO_HELD_DRAFT",
        proxy: {
          correlation_id: "corr-1",
          route_family: "agent-api/send",
          failure_class: "local_precondition",
          cause_code: "NO_HELD_DRAFT",
          response_started: false,
          response_complete: false,
        },
      },
      { status: 400 },
    ),
  );
  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  )
    .send("@ada", undefined, { sendDraft: true })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  const cliError = error as CliError;
  expect(cliError.code).toBe("NO_HELD_DRAFT");
  expect(cliError.draftSaved).toBe(false);
  expect(cliError.suggestedNextAction).toContain("No message was sent");
});

test("a send that fails after a transport/protocol failure marks the draft saved and refuses to say it is safe to retry", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      {
        error: "upstream HTTP response failed",
        code: "agent_proxy_failed",
        proxy: {
          correlation_id: "corr-2",
          route_family: "agent-api/send",
          failure_class: "upstream_http_response",
          cause_code: "HTTP_500",
          upstream_layer: "http_status",
          upstream_status: 500,
          response_started: true,
          response_complete: true,
        },
      },
      { status: 500 },
    ),
  );
  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  )
    .send("@ada", "hi")
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  const cliError = error as CliError;
  expect(cliError.code).toBe("SERVER_5XX");
  expect(cliError.draftSaved).toBe(true);
  expect(cliError.retryable).toBe(false);
  expect(cliError.correlationId).toBe("corr-2");
  expect(cliError.suggestedNextAction).toContain("Do not resend on this evidence");
});

test("a network failure reaching the local daemon proxy is treated as possibly-issued for send", async () => {
  spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  )
    .send("@ada", "hi")
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  const cliError = error as CliError;
  expect(cliError.draftSaved).toBe(true);
  expect(cliError.retryable).toBe(false);
});

test.each([
  [false, "react"],
  [true, "unreact"],
] as const)("react posts the messageId and emoji as a %s operation", async (remove, operation) => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ requestId: "request", accepted: true, attentionCount: 0, messages: [] }),
  );
  await connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).react(
    "abcd1234",
    "👍",
    remove,
  );
  const [, init] = fetch.mock.calls[0]!;
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({ operation, messageId: "abcd1234", emoji: "👍" });
});

test("the incident: a protocol mismatch after an upstream 200 is INVALID_JSON_RESPONSE, never SERVER_5XX", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      {
        error: "upstream response could not be decoded",
        code: "agent_proxy_failed",
        detail: 'agent send: response state is not one of "sent"/"held"/"denied" (got undefined)',
        proxy: {
          correlation_id: "corr-3",
          route_family: "agent-api/send",
          failure_class: "protocol_mismatch",
          cause_code: "AGENT_RESPONSE_SHAPE_INVALID",
          upstream_layer: "response_decode",
          upstream_status: 200,
          response_started: true,
          response_complete: true,
        },
      },
      { status: 502 },
    ),
  );
  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  )
    .send("@ada", "hi")
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  const cliError = error as CliError;
  expect(cliError.code).toBe("INVALID_JSON_RESPONSE");
  expect(cliError.proxy?.upstreamStatus).toBe(200);
  expect(cliError.draftSaved).toBe(true);
  expect(cliError.retryable).toBe(false);
});

test("a reviewer-isolated send still learns a local precondition (no upstream detail involved)", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      {
        error: "No held draft for target: @ada",
        code: "NO_HELD_DRAFT",
        proxy: {
          correlation_id: "corr-4",
          route_family: "agent-api/send",
          failure_class: "local_precondition",
          cause_code: "NO_HELD_DRAFT",
          response_started: false,
          response_complete: false,
        },
      },
      { status: 400 },
    ),
  );
  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  )
    .send("@ada", undefined, { sendDraft: true, freshnessContextMode: "withheld" })
    .catch((caught: unknown) => caught);
  const cliError = error as CliError;
  expect(cliError.code).toBe("NO_HELD_DRAFT");
  expect(cliError.draftSaved).toBe(false);
});
