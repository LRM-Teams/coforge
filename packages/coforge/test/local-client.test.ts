import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("a 404 attachment download fails as VIEW_FAILED with a fixed unavailable message", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
  const attempt = connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  ).view("attachment-1");
  await expect(attempt).rejects.toBeInstanceOf(CliError);
  await expect(attempt).rejects.toMatchObject({
    code: "VIEW_FAILED",
    message: "Attachment is unavailable.",
  });
});

test("a non-404 attachment download failure maps to VIEW_FAILED (or SERVER_5XX for >= 500)", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("access denied", { status: 403 }));
  const denied = connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  ).view("attachment-1");
  await expect(denied).rejects.toMatchObject({ code: "VIEW_FAILED", message: "access denied" });

  spyOn(globalThis, "fetch").mockResolvedValue(new Response("internal error", { status: 500 }));
  const failed = connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  ).view("attachment-1");
  await expect(failed).rejects.toMatchObject({ code: "SERVER_5XX" });
});

test("uploads an attachment after checking capabilities through the same GET forwarding as view", async () => {
  const calls: Array<{ url: string; method?: string; authorization: string | null }> = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url.endsWith("/capabilities"))
      return Response.json({
        maxBytes: 1024,
        directUploadEnabled: false,
        directUploadThresholdBytes: 0,
        sessionExpiresInSeconds: 900,
      });
    return Response.json({
      id: "attachment-1",
      fileName: "note.txt",
      contentType: "text/plain",
      sizeBytes: 5,
    });
  }) as typeof fetch);
  const dir = await mkdtemp(join(tmpdir(), "coforge-local-client-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    const result = await connectLocal(
      "",
      `sfp_${"a".repeat(43)}`,
      proxyUrl(agentApiRoutes.local.messages),
    ).upload!({ path, target: "@ada", mimeType: "text/plain" });
    expect(result).toEqual({
      id: "attachment-1",
      fileName: "note.txt",
      contentType: "text/plain",
      sizeBytes: 5,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(calls[0]?.url).toBe(proxyUrl(agentApiRoutes.local.attachments.path("capabilities")));
  expect(calls[0]?.authorization).toBe(`Bearer sfp_${"a".repeat(43)}`);
  expect(calls[1]?.url).toBe(proxyUrl(agentApiRoutes.local.attachments.upload.path));
  expect(calls[1]?.method).toBe("POST");
});

test("rejects an oversized upload locally after reading capabilities, without POSTing the file", async () => {
  const calls: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    calls.push(String(input));
    return Response.json({
      maxBytes: 2,
      directUploadEnabled: false,
      directUploadThresholdBytes: 0,
      sessionExpiresInSeconds: 900,
    });
  }) as typeof fetch);
  const dir = await mkdtemp(join(tmpdir(), "coforge-local-client-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    const attempt = connectLocal(
      "",
      `sfp_${"a".repeat(43)}`,
      proxyUrl(agentApiRoutes.local.messages),
    ).upload!({ path, target: "@ada" });
    await expect(attempt).rejects.toBeInstanceOf(CliError);
    await expect(attempt).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
      message: "File is 5 bytes; the server allows at most 2 bytes.",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(calls).toHaveLength(1);
});

test("maps a non-2xx upload response to a CliError carrying the upstream error text", async () => {
  spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    if (String(input).endsWith("/capabilities"))
      return Response.json({
        maxBytes: 1024,
        directUploadEnabled: false,
        directUploadThresholdBytes: 0,
        sessionExpiresInSeconds: 900,
      });
    return Response.json({ error: "Agent is not a member of #general" }, { status: 403 });
  }) as typeof fetch);
  const dir = await mkdtemp(join(tmpdir(), "coforge-local-client-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    const attempt = connectLocal(
      "",
      `sfp_${"a".repeat(43)}`,
      proxyUrl(agentApiRoutes.local.messages),
    ).upload!({ path, target: "#general" });
    await expect(attempt).rejects.toMatchObject({
      code: "UPLOAD_FAILED",
      message: "Agent is not a member of #general",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maps a >=500 upload response to SERVER_5XX", async () => {
  spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    if (String(input).endsWith("/capabilities"))
      return Response.json({
        maxBytes: 1024,
        directUploadEnabled: false,
        directUploadThresholdBytes: 0,
        sessionExpiresInSeconds: 900,
      });
    return new Response("internal error", { status: 500 });
  }) as typeof fetch);
  const dir = await mkdtemp(join(tmpdir(), "coforge-local-client-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    const attempt = connectLocal(
      "",
      `sfp_${"a".repeat(43)}`,
      proxyUrl(agentApiRoutes.local.messages),
    ).upload!({ path, target: "@ada" });
    await expect(attempt).rejects.toMatchObject({ code: "SERVER_5XX" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a 404 from the capabilities route skips the client-side size check, matching Raft 1.0.32", async () => {
  const calls: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    calls.push(String(input));
    if (String(input).endsWith("/capabilities")) return new Response("not found", { status: 404 });
    return Response.json({
      id: "attachment-1",
      fileName: "huge.bin",
      contentType: "application/octet-stream",
      sizeBytes: 5,
    });
  }) as typeof fetch);
  const dir = await mkdtemp(join(tmpdir(), "coforge-local-client-"));
  const path = join(dir, "huge.bin");
  await writeFile(path, "hello");
  try {
    const result = await connectLocal(
      "",
      `sfp_${"a".repeat(43)}`,
      proxyUrl(agentApiRoutes.local.messages),
    ).upload!({ path, target: "@ada" });
    expect(result.id).toBe("attachment-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(calls).toHaveLength(2);
});

test("a non-2xx, non-404 capabilities response fails as UPLOAD_CAPABILITY_FAILED before any upload POST", async () => {
  let uploadPosted = false;
  spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    if (String(input).endsWith("/capabilities"))
      return new Response("internal error", { status: 500 });
    uploadPosted = true;
    return Response.json({});
  }) as typeof fetch);
  const dir = await mkdtemp(join(tmpdir(), "coforge-local-client-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    const attempt = connectLocal(
      "",
      `sfp_${"a".repeat(43)}`,
      proxyUrl(agentApiRoutes.local.messages),
    ).upload!({ path, target: "@ada" });
    await expect(attempt).rejects.toMatchObject({ code: "UPLOAD_CAPABILITY_FAILED" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(uploadPosted).toBe(false);
});

test("the CLI's multipart upload request carries a trustworthy content-length header (real HTTP round trip)", async () => {
  let observedContentLength: string | null = null;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/capabilities")) {
        return Response.json({
          maxBytes: 1024,
          directUploadEnabled: false,
          directUploadThresholdBytes: 0,
          sessionExpiresInSeconds: 900,
        });
      }
      observedContentLength = request.headers.get("content-length");
      return Response.json({
        id: "attachment-1",
        fileName: "note.txt",
        contentType: "text/plain",
        sizeBytes: 5,
      });
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "coforge-local-client-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    await connectLocal(
      "",
      `sfp_${"a".repeat(43)}`,
      `http://127.0.0.1:${server.port}/api/agent/v1/messages`,
    ).upload!({ path, target: "@ada", mimeType: "text/plain" });
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
  // Bun's fetch computes Content-Length for a FormData body (it knows every part's size up
  // front), the same way it does for a Blob or string body. The daemon-local proxy
  // (agent-proxy.ts) rejects an upload with 413 when this header is missing or untrustworthy;
  // this confirms the CLI's real request never hits that path.
  expect(observedContentLength).not.toBeNull();
  expect(Number(observedContentLength)).toBeGreaterThan(0);
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

test("a local precondition that explicitly saved a draft (e.g. --target-confirmed) reports draftSaved: true", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      {
        error: "Possible thread target mismatch: ...",
        code: "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED",
        proxy: {
          correlation_id: "corr-2",
          route_family: "agent-api/send",
          failure_class: "local_precondition",
          cause_code: "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED",
          response_started: false,
          response_complete: false,
          draft_saved: true,
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
    .send("@ada", "top-level reply")
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  const cliError = error as CliError;
  expect(cliError.code).toBe("THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED");
  expect(cliError.draftSaved).toBe(true);
  expect(cliError.retryable).toBe(false);
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

test("channel: a 404 from a target operation becomes CliError NOT_FOUND with a fixed message", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("channel not found", { status: 404 }));
  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.channels),
  )
    .channel({ operation: "join", target: "#missing" })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  const cliError = error as CliError;
  expect(cliError.code).toBe("NOT_FOUND");
  expect(cliError.message).toBe("Channel not found: #missing");
  expect(cliError.retryable).toBe(false);
});

test("channel: a 404 from info/members (no single-channel target operation) is not remapped to NOT_FOUND", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("channel not found", { status: 404 }));
  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.channels),
  )
    .channel({ operation: "info", target: "#missing" })
    .catch((caught: unknown) => caught);
  expect(error).not.toBeInstanceOf(CliError);
  expect(error).toBeInstanceOf(Error);
});

test("channel: a successful response is returned as parsed JSON", async () => {
  const rawResponse = {
    protocolMajor: 1,
    requestId: "r-1",
    target: "#eng",
    joined: true,
    alreadyJoined: false,
  };
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json(rawResponse));
  const result = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.channels),
  ).channel({ operation: "join", target: "#eng" });
  expect(result).toEqual(rawResponse);
});
