import { expect, test } from "bun:test";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
} from "../workspace-memory/profile";
import {
  createInMemoryWorkspaceMemoryProfileStore,
  saveProfileTransition,
} from "../workspace-memory/stores";
import { lookupAggregatedRoute } from "./catalog/aggregated-catalog";
import { createOpenVikingPolicyGateway } from "./policy-gateway.server";
import { classifyOpenVikingRoute } from "./route-policy";
import { createOpenVikingRuntimeClient, type FetchImpl } from "./runtime-client.server";
import { createInMemoryOpenVikingBindingStore } from "./stores";
import {
  OPENVIKING_TYPED_SESSION_COMMIT_ROUTE,
  OPENVIKING_TYPED_SESSION_EXTRACT_ROUTE,
  createOpenVikingTypedSessionExtract,
  type OpenVikingAdmittedSessionWrite,
} from "./typed-session-extract.server";

const SINK_IDENTITY = {
  accountId: "acct-ws-a",
  userId: "workspace-memory-sink",
  role: "user" as const,
  authorization: "Bearer server-held-sink",
};

const SAMPLE_WRITE: OpenVikingAdmittedSessionWrite = {
  sessionId: "coforge-quiet-ch-eng-m-live",
  workspaceId: "ws-a",
  tags: [
    "coforge_segment=quiet-ch-eng-m-live",
    "coforge_workspace=ws-a",
    "coforge_channel=ch-eng",
    "coforge_kind=quiet_window",
    "coforge_source_message_ids=m-live",
  ],
  messages: [
    {
      role: "user",
      content: "standup note",
      createdAt: "2026-09-21T12:05:00.000Z",
      sourceMessageIds: ["m-live"],
    },
  ],
};

function headersFrom(init: RequestInit | undefined): Record<string, string> {
  const headers = new Headers(init?.headers);
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

function channel(fetchImpl: FetchImpl, authorizedOwner = "sink-owner") {
  return createOpenVikingTypedSessionExtract({
    runtime: createOpenVikingRuntimeClient({
      baseUrl: "http://ov.internal:1933",
      fetchImpl,
    }),
    authorizedOwner,
    sinkIdentity: SINK_IDENTITY,
  });
}

test("session commit and extract are typed-control-only and stay off the generic gateway", async () => {
  expect(classifyOpenVikingRoute(OPENVIKING_TYPED_SESSION_COMMIT_ROUTE)).toBe("denied");
  expect(classifyOpenVikingRoute(OPENVIKING_TYPED_SESSION_EXTRACT_ROUTE)).toBe("denied");
  expect(
    lookupAggregatedRoute(
      OPENVIKING_TYPED_SESSION_COMMIT_ROUTE.method,
      "/api/v1/sessions/coforge-quiet-ch-eng-m-live/commit",
    )?.classification,
  ).toBe("typed-control-only");
  expect(
    lookupAggregatedRoute(
      OPENVIKING_TYPED_SESSION_EXTRACT_ROUTE.method,
      "/api/v1/sessions/coforge-quiet-ch-eng-m-live/extract",
    )?.classification,
  ).toBe("typed-control-only");
  const source = await Bun.file(
    new URL("./typed-session-extract.server.ts", import.meta.url),
  ).text();
  expect(source).not.toMatch(/createOpenVikingPolicyGateway|handleOpenVikingGatewayRequest/);
});

test("typed session extract refuses a non-owner without calling OpenViking", async () => {
  let called = false;
  const sessions = channel(async () => {
    called = true;
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  });
  expect(
    await sessions.writeCommitAndExtract({
      owner: "intruder",
      write: SAMPLE_WRITE,
    }),
  ).toEqual({ ok: false, sanitizedError: "sink owner is not authorized" });
  expect(called).toBe(false);
});

test("typed session extract writes the session then commits then extracts with server-held credentials", async () => {
  const captured: Array<{
    url: string;
    method?: string;
    headers: Record<string, string>;
    body: string;
  }> = [];
  const sessions = channel(async (input, init) => {
    captured.push({
      url: String(input),
      method: init?.method,
      headers: headersFrom(init),
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(
      JSON.stringify({ status: "ok", result: { session_id: SAMPLE_WRITE.sessionId } }),
      {
        status: 200,
      },
    );
  });
  expect(
    await sessions.writeCommitAndExtract({
      owner: "sink-owner",
      write: SAMPLE_WRITE,
    }),
  ).toEqual({ ok: true, sessionId: SAMPLE_WRITE.sessionId });
  expect(captured.map((row) => [row.method, row.url])).toEqual([
    ["POST", "http://ov.internal:1933/api/v1/sessions"],
    ["POST", "http://ov.internal:1933/api/v1/sessions/coforge-quiet-ch-eng-m-live/messages/batch"],
    ["POST", "http://ov.internal:1933/api/v1/sessions/coforge-quiet-ch-eng-m-live/commit"],
    ["POST", "http://ov.internal:1933/api/v1/sessions/coforge-quiet-ch-eng-m-live/extract"],
  ]);
  expect(captured.every((row) => row.headers.authorization === "Bearer server-held-sink")).toBe(
    true,
  );
  expect(captured[0]?.headers["x-openviking-account"]).toBe("acct-ws-a");
  expect(captured[0]?.headers["x-openviking-user"]).toBe("workspace-memory-sink");
  const createBody = JSON.parse(captured[0]!.body) as {
    session_id: string;
    memory_extraction_config: { events: { tags: string[] } };
  };
  expect(createBody.session_id).toBe(SAMPLE_WRITE.sessionId);
  expect(createBody.memory_extraction_config.events.tags).toEqual([...SAMPLE_WRITE.tags]);
  expect(JSON.stringify(createBody)).not.toMatch(/causal|cm_fact|provenance|audit_id/);
  const batchBody = JSON.parse(captured[1]!.body) as {
    messages: Array<{ source_message_ids: string[] }>;
  };
  expect(batchBody.messages[0]?.source_message_ids).toEqual(["m-live"]);
});

test("typed session extract waits for the commit task and does not extract an archived session", async () => {
  const captured: string[] = [];
  let polls = 0;
  const sessions = channel(async (input, init) => {
    const url = String(input);
    captured.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/commit")) {
      return new Response(
        JSON.stringify({ status: "ok", result: { task_id: "task-1", archived: true } }),
        { status: 200 },
      );
    }
    if (url.endsWith("/tasks/task-1")) {
      polls += 1;
      const status = polls < 2 ? "running" : "completed";
      return new Response(JSON.stringify({ status: "ok", result: { status } }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "ok", result: {} }), { status: 200 });
  }, "sink-owner");
  expect(
    await sessions.writeCommitAndExtract({
      owner: "sink-owner",
      write: SAMPLE_WRITE,
    }),
  ).toEqual({ ok: true, sessionId: SAMPLE_WRITE.sessionId });
  expect(captured.filter((line) => line.includes("/extract"))).toEqual([]);
  expect(captured.filter((line) => line.includes("/tasks/task-1"))).toHaveLength(2);
});

test("typed session extract fails closed when the commit task fails", async () => {
  const sessions = createOpenVikingTypedSessionExtract({
    runtime: createOpenVikingRuntimeClient({
      baseUrl: "http://ov.internal:1933",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/commit")) {
          return new Response(JSON.stringify({ status: "ok", result: { task_id: "task-fail" } }), {
            status: 200,
          });
        }
        if (url.endsWith("/tasks/task-fail")) {
          return new Response(JSON.stringify({ status: "ok", result: { status: "failed" } }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ status: "ok", result: {} }), { status: 200 });
      },
    }),
    authorizedOwner: "sink-owner",
    sinkIdentity: SINK_IDENTITY,
    commitTimeoutMs: 1_000,
    sleep: async () => undefined,
  });
  expect(
    await sessions.writeCommitAndExtract({
      owner: "sink-owner",
      write: SAMPLE_WRITE,
    }),
  ).toEqual({ ok: false, sanitizedError: "openviking session extract failed" });
});

test("typed session extract keeps a remote failure sanitized and never reports success", async () => {
  const sessions = channel(async (input) => {
    if (String(input).endsWith("/commit")) {
      return new Response("secret token leaked", { status: 500 });
    }
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  });
  expect(
    await sessions.writeCommitAndExtract({
      owner: "sink-owner",
      write: SAMPLE_WRITE,
    }),
  ).toEqual({ ok: false, sanitizedError: "openviking session extract failed" });
  const unavailable = channel(async () => {
    throw new Error("ECONNREFUSED Bearer ov-secret");
  });
  expect(
    await unavailable.writeCommitAndExtract({
      owner: "sink-owner",
      write: SAMPLE_WRITE,
    }),
  ).toEqual({ ok: false, sanitizedError: "openviking session extract failed" });
  expect(
    await channel(async () => new Response(null, { status: 200 })).writeCommitAndExtract({
      owner: "sink-owner",
      write: { ...SAMPLE_WRITE, sessionId: "../admin" },
    }),
  ).toEqual({ ok: false, sanitizedError: "openviking session extract failed" });
});

test("the policy gateway cannot forward typed session commit or extract", async () => {
  const now = new Date("2026-09-21T12:00:00.000Z");
  const profiles = createInMemoryWorkspaceMemoryProfileStore();
  const bindings = createInMemoryOpenVikingBindingStore();
  const seed = createDefaultWorkspaceMemoryProfile("ws-a");
  const selected = applyWorkspaceMemoryCommand(
    seed,
    { type: "select_desired", desired: "openviking", at: now },
    { prototypeEnabled: true },
  );
  expect(selected.ok).toBe(true);
  if (!selected.ok) throw new Error(selected.failure.code);
  const ready = applyWorkspaceMemoryCommand(selected.profile, {
    type: "observe_ready",
    generation: selected.profile.generation,
  });
  expect(ready.ok).toBe(true);
  if (!ready.ok) throw new Error(ready.failure.code);
  expect(await saveProfileTransition(profiles, seed, ready.profile)).toBe("saved");
  expect(
    await bindings.compareAndSet({
      workspaceId: "ws-a",
      expectedGeneration: 0,
      binding: {
        workspaceId: "ws-a",
        accountId: "acct-ws-a",
        serviceIdentityId: "svc-ws-a",
        credentialRef: "secret:ov-ws-a",
        generation: ready.profile.generation,
      },
    }),
  ).toBe("saved");

  let forwarded = false;
  const gateway = createOpenVikingPolicyGateway({
    profiles,
    bindings,
    runtime: {
      async request() {
        forwarded = true;
        return {
          ok: true,
          response: {
            status: 202,
            headers: {},
            body: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
          },
        };
      },
    },
    resolveAuthorization: async () => "Bearer server-held-ov-key",
  });
  const commitDenied = await gateway.forward(
    { kind: "owner", userId: "u-1" },
    {
      workspaceId: "ws-a",
      method: "POST",
      path: "/api/v1/sessions/coforge-quiet-ch-eng-m-live/commit",
    },
  );
  const extractDenied = await gateway.forward(
    { kind: "owner", userId: "u-1" },
    {
      workspaceId: "ws-a",
      method: "POST",
      path: "/api/v1/sessions/coforge-quiet-ch-eng-m-live/extract",
    },
  );
  expect(commitDenied.ok).toBe(false);
  expect(extractDenied.ok).toBe(false);
  expect(forwarded).toBe(false);
});
