import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { connectLocal } from "#src/local-client";
import { CliError } from "#src/cli-error";

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

test("forwards attachmentIds, mentions, and targetConfirmed on a send request", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ requestId: "request", accepted: true, attentionCount: 0, messages: [] }),
  );
  const mentions = [{ type: "user" as const, id: "actor-1", name: "ada" }];

  await connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).send(
    "@ada",
    "hi @ada",
    { attachmentIds: ["attachment-1", "attachment-2"], mentions, targetConfirmed: true },
  );

  const [, init] = fetch.mock.calls[0]!;
  const body = JSON.parse(init!.body as string);
  expect(body.attachmentIds).toEqual(["attachment-1", "attachment-2"]);
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

test("requests GitHub commit trailers through the daemon-local proxy", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      trailers: ["Co-authored-by: coforge-staging[bot] <1+bot@users.noreply.github.com>"],
    }),
  );
  const trailers = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  ).githubCommitTrailers!("acme/widgets");

  expect(trailers).toEqual([
    "Co-authored-by: coforge-staging[bot] <1+bot@users.noreply.github.com>",
  ]);
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toEqual(new URL(proxyUrl(agentApiRoutes.proxy.githubCommitTrailers.path)));
  expect(init).toMatchObject({
    method: "POST",
    headers: {
      authorization: `Bearer sfp_${"a".repeat(43)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ repository: "acme/widgets" }),
  });
});

test("rejects malformed GitHub commit trailers from the daemon-local proxy", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ trailers: [1] }));

  await expect(
    connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages))
      .githubCommitTrailers!(null),
  ).rejects.toThrow("invalid GitHub commit trailers response");
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
  ).rejects.toMatchObject({
    code: "UPDATE_FAILED",
    message:
      "Reviewer-isolation task update failed (HTTP 400); upstream error detail was withheld.",
  });
});

test("a refused Task write fails typed with its operation's code and the proxy's reason", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      {
        error: "this agent is not allowed to do that",
        code: "ACCESS_DENIED",
        proxy: {
          correlation_id: "correlation-1",
          route_family: "agent-api/task",
          failure_class: "upstream_http_response",
          upstream_status: 403,
        },
      },
      { status: 403 },
    ),
  );
  const attempt = connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  ).task({
    idempotencyKey: "request",
    operation: "assign",
    target: "#general",
    number: 1,
    assignee: "@ada",
  });
  await expect(attempt).rejects.toBeInstanceOf(CliError);
  await expect(attempt).rejects.toMatchObject({
    code: "ASSIGN_FAILED",
    message: "this agent is not allowed to do that",
    correlationId: "correlation-1",
    proxy: { upstreamStatus: 403 },
  });
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

/**
 * A real `Bun.serve` fake standing in for both the local daemon proxy (capabilities, session
 * create/complete/cancel) and the presigned PUT target, so the CLI's direct-upload flow runs a
 * genuine streamed HTTP PUT (`duplex: "half"`) rather than a mocked `fetch`. `putBehavior` is
 * mutated by each test to script the PUT endpoint's response(s) across attempts.
 */
function directUploadServer(input: {
  putBehavior: () => number | "ok";
  onCancel?: () => void;
  completeBehavior?: () => { status: number; body: unknown };
}) {
  const completions: string[] = [];
  const puts: Array<{ headers: Headers; body: string }> = [];
  let port = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/capabilities")) {
        return Response.json({
          maxBytes: 1024,
          directUploadEnabled: true,
          directUploadThresholdBytes: 1,
          sessionExpiresInSeconds: 900,
        });
      }
      if (
        url.pathname === "/api/agent/v1/attachment-upload-sessions" &&
        request.method === "POST"
      ) {
        return Response.json(
          {
            uploadId: "upload-1",
            attachmentId: "attachment-1",
            state: "pending",
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
            upload: {
              method: "PUT",
              url: `http://127.0.0.1:${port}/presigned/attachment-1`,
              headers: { "Content-Type": "text/plain", "x-oss-forbid-overwrite": "true" },
            },
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/api/agent/v1/attachment-upload-sessions/upload-1/complete") {
        completions.push("complete");
        const behavior = input.completeBehavior?.() ?? {
          status: 200,
          body: {
            uploadId: "upload-1",
            state: "completed",
            attachment: {
              id: "attachment-1",
              fileName: "note.txt",
              contentType: "text/plain",
              sizeBytes: 5,
            },
          },
        };
        return Response.json(behavior.body, { status: behavior.status });
      }
      if (
        url.pathname === "/api/agent/v1/attachment-upload-sessions/upload-1" &&
        request.method === "DELETE"
      ) {
        input.onCancel?.();
        return Response.json({ uploadId: "upload-1", state: "canceled" });
      }
      if (url.pathname === "/presigned/attachment-1" && request.method === "PUT") {
        puts.push({ headers: request.headers, body: await request.text() });
        const outcome = input.putBehavior();
        return outcome === "ok" ? new Response(null) : new Response(null, { status: outcome });
      }
      return new Response("not found", { status: 404 });
    },
  });
  port = server.port ?? 0;
  return { server, completions, puts };
}

test("direct upload: succeeds on the first PUT and completes on the first try", async () => {
  const { server, puts } = directUploadServer({ putBehavior: () => "ok" });
  const dir = await mkdtemp(join(tmpdir(), "coforge-local-client-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    const result = await connectLocal(
      "",
      `sfp_${"a".repeat(43)}`,
      `http://127.0.0.1:${server.port}/api/agent/v1/messages`,
    ).upload!({ path, target: "@ada", mimeType: "text/plain" });
    expect(result).toEqual({
      id: "attachment-1",
      fileName: "note.txt",
      contentType: "text/plain",
      sizeBytes: 5,
    });
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
  expect(puts).toHaveLength(1);
  expect(puts[0]?.headers.get("x-oss-forbid-overwrite")).toBe("true");
  expect(puts[0]?.body).toBe("hello");
  // A `Blob` body (`Bun.file(path)`) has a known size, so `fetch` sends a real `Content-Length`
  // and never falls back to chunked transfer encoding; OSS's PutObject needs the former and
  // rejects the latter in its place.
  expect(puts[0]?.headers.get("content-length")).toBe("5");
  expect(puts[0]?.headers.get("transfer-encoding")).toBeNull();
});

test("direct upload: OSS's 409 (already exists) is not retried and still completes", async () => {
  const { server, puts } = directUploadServer({ putBehavior: () => 409 });
  const dir = await mkdtemp(join(tmpdir(), "coforge-local-client-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    const result = await connectLocal(
      "",
      `sfp_${"a".repeat(43)}`,
      `http://127.0.0.1:${server.port}/api/agent/v1/messages`,
    ).upload!({ path, target: "@ada", mimeType: "text/plain" });
    expect(result.id).toBe("attachment-1");
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
  expect(puts).toHaveLength(1);
});

test("direct upload: retries once on a 503 and succeeds on the second PUT attempt", async () => {
  let attempt = 0;
  const { server, puts } = directUploadServer({
    putBehavior: () => {
      attempt += 1;
      return attempt === 1 ? 503 : "ok";
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "coforge-local-client-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    const result = await connectLocal(
      "",
      `sfp_${"a".repeat(43)}`,
      `http://127.0.0.1:${server.port}/api/agent/v1/messages`,
    ).upload!({ path, target: "@ada", mimeType: "text/plain" });
    expect(result.id).toBe("attachment-1");
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
  expect(puts).toHaveLength(2);
});

test("direct upload: a definite PUT failure (400) cancels the session and never calls complete", async () => {
  let canceled = false;
  const { server, completions } = directUploadServer({
    putBehavior: () => 400,
    onCancel: () => {
      canceled = true;
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "coforge-local-client-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    const attempt = connectLocal(
      "",
      `sfp_${"a".repeat(43)}`,
      `http://127.0.0.1:${server.port}/api/agent/v1/messages`,
    ).upload!({ path, target: "@ada", mimeType: "text/plain" });
    await expect(attempt).rejects.toMatchObject({ code: "UPLOAD_OBJECT_PUT_FAILED" });
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
  expect(canceled).toBe(true);
  expect(completions).toHaveLength(0);
});

test("direct upload: an ambiguous outcome after the retry (persistent 503) still completes without canceling", async () => {
  let canceled = false;
  const { server, completions } = directUploadServer({
    putBehavior: () => 503,
    onCancel: () => {
      canceled = true;
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "coforge-local-client-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    const result = await connectLocal(
      "",
      `sfp_${"a".repeat(43)}`,
      `http://127.0.0.1:${server.port}/api/agent/v1/messages`,
    ).upload!({ path, target: "@ada", mimeType: "text/plain" });
    expect(result.id).toBe("attachment-1");
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
  expect(canceled).toBe(false);
  expect(completions).toHaveLength(1);
});

test("direct upload: completion retries on UPLOAD_OBJECT_NOT_FOUND and succeeds on the third try", async () => {
  let completeAttempt = 0;
  const { server, completions } = directUploadServer({
    putBehavior: () => "ok",
    completeBehavior: () => {
      completeAttempt += 1;
      if (completeAttempt < 3)
        return {
          status: 404,
          body: {
            error: "uploaded object is not visible yet",
            code: "UPLOAD_OBJECT_NOT_FOUND",
            retryable: true,
          },
        };
      return {
        status: 200,
        body: {
          uploadId: "upload-1",
          state: "completed",
          attachment: {
            id: "attachment-1",
            fileName: "note.txt",
            contentType: "text/plain",
            sizeBytes: 5,
          },
        },
      };
    },
  });
  const dir = await mkdtemp(join(tmpdir(), "coforge-local-client-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    const result = await connectLocal(
      "",
      `sfp_${"a".repeat(43)}`,
      `http://127.0.0.1:${server.port}/api/agent/v1/messages`,
    ).upload!({ path, target: "@ada", mimeType: "text/plain" });
    expect(result.id).toBe("attachment-1");
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
  expect(completions).toHaveLength(3);
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
  const upstream500 = () =>
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
    );
  // A fresh response per attempt: a mock that reuses one body would be consumed after the first read.
  const fetch = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(upstream500())
    .mockResolvedValueOnce(upstream500())
    .mockResolvedValueOnce(upstream500());
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
  // A transient gateway 5xx is retried first; only the exhaustion reports the unknown state.
  expect(fetch).toHaveBeenCalledTimes(3);
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

test("channel: an agent_not_visible JSON envelope becomes CliError AGENT_NOT_VISIBLE, never the fixed Channel-not-found text", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      { ok: false, errorCode: "agent_not_visible", error: "@ghost is not visible to you." },
      { status: 404 },
    ),
  );
  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.channels),
  )
    .channel({ operation: "add-member", target: "#eng", agent: "@ghost" })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  const cliError = error as CliError;
  expect(cliError.code).toBe("AGENT_NOT_VISIBLE");
  expect(cliError.message).toBe("@ghost is not visible to you.");
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

test("version GETs the local-only /api/agent/v1/version route and decodes the live daemon's response", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ ok: true, daemonVersion: "0.1.0-dev.38", computerVersion: "0.1.0-dev.38" }),
  );
  const result = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.proxy.version),
  ).version();
  expect(fetch.mock.calls[0]?.[0]).toEqual(new URL(proxyUrl(agentApiRoutes.proxy.version)));
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  expect(result).toEqual({
    ok: true,
    daemonVersion: "0.1.0-dev.38",
    computerVersion: "0.1.0-dev.38",
  });
});

test("version reports the live daemon could not be queried on a network/timeout failure", async () => {
  spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.proxy.version),
  )
    .version()
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  const cliError = error as CliError;
  expect(cliError.code).toBe("VERSION_FAILED");
  expect(cliError.message).toContain("The live daemon could not be queried");
});

test("version maps a >=500 proxy response to SERVER_5XX", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 502 }));
  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.proxy.version),
  )
    .version()
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("SERVER_5XX");
});

test("version without a configured Agent proxy URL fails as a local precondition before any request", async () => {
  const fetch = spyOn(globalThis, "fetch");
  const error = await connectLocal("", `sfp_${"a".repeat(43)}`, "")
    .version()
    .catch((caught: unknown) => caught);
  expect(fetch).not.toHaveBeenCalled();
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("VERSION_FAILED");
});

test("retries a send that hit a transient upstream 502, reusing the same requestId", async () => {
  const fetch = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json(
        {
          code: "SERVER_5XX",
          error: "upstream unavailable",
          proxy: { failure_class: "upstream_http_response", upstream_status: 502 },
        },
        { status: 502 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({ requestId: "request", accepted: true, attentionCount: 0, messages: [] }),
    );
  const client = connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages));

  await client.send("@ada", "hello");

  expect(fetch).toHaveBeenCalledTimes(2);
  const first = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
  const second = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
  // The same requestId is what makes the retry safe: the server suppresses the duplicate.
  expect(second.requestId).toEqual(first.requestId);
});

test("retries a send that never reached the proxy at all", async () => {
  const fetch = spyOn(globalThis, "fetch")
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValueOnce(
      Response.json({ requestId: "request", accepted: true, attentionCount: 0, messages: [] }),
    );

  await connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).send(
    "@ada",
    "hello",
  );

  expect(fetch).toHaveBeenCalledTimes(2);
});

test("does not retry a send the server refused with a definite answer", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      {
        code: "NOT_FOUND",
        error: "no such target",
        proxy: { failure_class: "upstream_http_response", upstream_status: 404 },
      },
      { status: 404 },
    ),
  );

  await expect(
    connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).send(
      "@ada",
      "hello",
    ),
  ).rejects.toThrow("no such target");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("still reports an unknown delivery state when every send attempt fails", async () => {
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));

  const error = await connectLocal(
    "",
    `sfp_${"a".repeat(43)}`,
    proxyUrl(agentApiRoutes.local.messages),
  )
    .send("@ada", "hello")
    .catch((caught: unknown) => caught as CliError);

  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("SEND_FAILED");
  expect((error as CliError).draftSaved).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test("never retries a non-send operation", async () => {
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));

  await expect(
    connectLocal("", `sfp_${"a".repeat(43)}`, proxyUrl(agentApiRoutes.local.messages)).check(),
  ).rejects.toThrow("agent proxy request failed (network or timeout)");
  expect(fetch).toHaveBeenCalledTimes(1);
});

const MENTION_CONTEXT = `sfp_${"a".repeat(43)}`;
const MENTION_ID = "22222222-2222-4222-8222-222222222222";

test("mention pending GETs the pending list through the Proxy", async () => {
  const body = { ok: true, pendingMentionActions: [] };
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
  const result = await connectLocal(
    "",
    MENTION_CONTEXT,
    proxyUrl(agentApiRoutes.local.messages),
  ).mentionPending();
  expect(result).toEqual({ ok: true, pendingMentionActions: [] });
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toEqual(new URL(proxyUrl(agentApiRoutes.local.mentionActions.pending)));
  expect(init?.method).toBe("GET");
});

test("mention add POSTs the action and its resolution ids through the Proxy", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ ok: true, action: "add", results: [] }),
  );
  await connectLocal("", MENTION_CONTEXT, proxyUrl(agentApiRoutes.local.messages)).mentionExecute({
    action: "add",
    resolutionIds: [MENTION_ID],
  });
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toEqual(new URL(proxyUrl(agentApiRoutes.local.mentionActions.execute)));
  expect(init?.method).toBe("POST");
  expect(JSON.parse(init!.body as string)).toEqual({ action: "add", resolutionIds: [MENTION_ID] });
});

test("a mention action server error is SERVER_5XX, and a refusal carries the server's text", async () => {
  spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ error: "upstream failed", code: "UPSTREAM_HTTP_ERROR" }, { status: 502 }),
  );
  const client = connectLocal("", MENTION_CONTEXT, proxyUrl(agentApiRoutes.local.messages));
  const serverError = (await client
    .mentionExecute({ action: "add", resolutionIds: [MENTION_ID] })
    .catch((caught: unknown) => caught)) as CliError;
  expect(serverError).toBeInstanceOf(CliError);
  expect(serverError.code).toBe("SERVER_5XX");

  spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json(
      { ok: false, errorCode: "invalid_request", error: 'action must be "add".' },
      { status: 400 },
    ),
  );
  const refusal = (await client
    .mentionExecute({ action: "add", resolutionIds: [MENTION_ID] })
    .catch((caught: unknown) => caught)) as CliError;
  expect(refusal.code).toBe("MENTION_ACTION_FAILED");
  expect(refusal.message).toBe('action must be "add".');

  spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("bad request", { status: 400 }));
  const pending = (await client.mentionPending().catch((caught: unknown) => caught)) as CliError;
  expect(pending.code).toBe("MENTION_PENDING_FAILED");
  expect(pending.message).toBe("bad request");
});
