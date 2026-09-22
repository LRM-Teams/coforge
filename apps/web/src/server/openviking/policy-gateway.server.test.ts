import { expect, test } from "bun:test";
import {
  applyWorkspaceMemoryCommand,
  createDefaultWorkspaceMemoryProfile,
} from "../workspace-memory/profile";
import { createWorkspaceMemoryProfiles } from "../workspace-memory/profiles";
import { createWorkspaceMemoryProfileReconciler } from "../workspace-memory/reconciler";
import {
  createInMemoryWorkspaceIdentityDirectory,
  createProductionMemoryRuntimeProvisioner,
  createPrototypeMemoryRuntimeReadiness,
} from "../workspace-memory/runtime-provisioner";
import {
  createFakeCausalMemoryProvisioner,
  createInMemoryWorkspaceMemoryProfileStore,
  saveProfileTransition,
} from "../workspace-memory/stores";
import type { CoforgeMemoryActor } from "./contract";
import { PINNED_OPENVIKING_ROUTES } from "./route-catalog";
import { sanitizeOpenVikingTransportFailure } from "./route-policy";
import { createOpenVikingRuntimeClient, type FetchImpl } from "./runtime-client.server";
import { createFakeOpenVikingProvisioner, createInMemoryOpenVikingBindingStore } from "./stores";
import {
  G2_TRACER_DATA_PLANE_ROUTES,
  G2_TRACER_ROUTE_CATALOG,
  createOpenVikingPolicyGateway,
  handleOpenVikingGatewayRequest,
  type OpenVikingGatewayRequest,
  type OpenVikingPolicyGateway,
} from "./policy-gateway.server";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const SERVER_AUTHORIZATION = "Bearer server-held-ov-key";
const ATTACKER_AUTHORIZATION = "Bearer attacker-key";
const WORKSPACE_ID = "ws-a";

const OWNER: CoforgeMemoryActor = { kind: "owner", userId: "u-1" };
const ADMIN: CoforgeMemoryActor = { kind: "admin", userId: "u-2" };
const MEMBER: CoforgeMemoryActor = { kind: "member", userId: "u-3" };
const AGENT: CoforgeMemoryActor = { kind: "agent", agentId: "ag-1" };
const MEMORY_AGENT: CoforgeMemoryActor = { kind: "memory_agent", agentId: "mem-1" };
const PROJECTION_WORKER: CoforgeMemoryActor = { kind: "projection_worker" };

const FIND: OpenVikingGatewayRequest = {
  workspaceId: WORKSPACE_ID,
  method: "POST",
  path: "/api/v1/search/find",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "alpha", limit: 10 }),
};

const RESOURCES_WRITE: OpenVikingGatewayRequest = {
  workspaceId: WORKSPACE_ID,
  method: "POST",
  path: "/api/v1/resources",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: "notes/alpha.md", content: "hello" }),
};

const SMUGGLED_HEADERS = {
  Authorization: ATTACKER_AUTHORIZATION,
  "X-API-Key": "stolen-key",
  "X-OpenViking-Account": "acct-evil",
  "X-OpenViking-User": "root",
  "X-OpenViking-Role": "root",
  "X-OpenViking-Actor-Peer": "peer-user",
  "Content-Type": "application/json",
};

function materializePath(path: string): string {
  return path.includes("{") ? path.replaceAll(/\{[^/]+\}/g, "sample") : path;
}

function headersFrom(init: RequestInit | undefined): Record<string, string> {
  const headers = new Headers(init?.headers);
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

async function seedReadyWorkspace(workspaceId = WORKSPACE_ID) {
  const profiles = createInMemoryWorkspaceMemoryProfileStore();
  const bindings = createInMemoryOpenVikingBindingStore();
  const provisioner = createProductionMemoryRuntimeProvisioner({
    openviking: createFakeOpenVikingProvisioner(),
    bindings,
    causal: createFakeCausalMemoryProvisioner(),
    identities: createInMemoryWorkspaceIdentityDirectory([
      OWNER,
      ADMIN,
      MEMBER,
      AGENT,
      MEMORY_AGENT,
    ]),
    readiness: createPrototypeMemoryRuntimeReadiness(),
  });
  const profileApi = createWorkspaceMemoryProfiles({
    store: profiles,
    gate: { prototypeEnabled: true },
  });
  const reconciler = createWorkspaceMemoryProfileReconciler({ store: profiles, provisioner });
  const selected = await profileApi.selectDesired({
    workspaceId,
    desired: "openviking",
    at: NOW,
  });
  expect(selected.ok).toBe(true);
  const ready = await reconciler.reconcile(workspaceId);
  expect(ready.ok).toBe(true);
  if (ready.ok) expect(ready.profile.observed).toBe("ready");
  return { profiles, bindings };
}

function recordingRuntime() {
  const calls: Array<{ method: string; path: string; headers?: Record<string, string> }> = [];
  return {
    calls,
    runtime: {
      async request(input: { method: string; path: string; headers?: Record<string, string> }) {
        calls.push({ method: input.method, path: input.path, headers: input.headers });
        return {
          ok: true as const,
          response: {
            status: 200,
            headers: { "content-type": "application/json" },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{}"));
                controller.close();
              },
            }),
          },
        };
      },
    },
  };
}

function createReadyGateway(overrides?: {
  profiles?: Awaited<ReturnType<typeof seedReadyWorkspace>>["profiles"];
  bindings?: Awaited<ReturnType<typeof seedReadyWorkspace>>["bindings"];
  runtime?: ReturnType<typeof recordingRuntime>["runtime"];
  fetchImpl?: FetchImpl;
  audit?: string[];
}): Promise<{
  gateway: OpenVikingPolicyGateway;
  calls: ReturnType<typeof recordingRuntime>["calls"];
  audit: string[];
  bindings: Awaited<ReturnType<typeof seedReadyWorkspace>>["bindings"];
}> {
  return (async () => {
    const seeded = overrides?.profiles
      ? {
          profiles: overrides.profiles,
          bindings: overrides.bindings ?? createInMemoryOpenVikingBindingStore(),
        }
      : await seedReadyWorkspace();
    const recorded = recordingRuntime();
    const audit = overrides?.audit ?? [];
    const runtime = overrides?.fetchImpl
      ? createOpenVikingRuntimeClient({
          baseUrl: "http://ov.internal:1933",
          fetchImpl: overrides.fetchImpl,
        })
      : (overrides?.runtime ?? recorded.runtime);
    return {
      gateway: createOpenVikingPolicyGateway({
        profiles: seeded.profiles,
        bindings: seeded.bindings,
        runtime,
        resolveAuthorization: async () => SERVER_AUTHORIZATION,
        catalog: G2_TRACER_ROUTE_CATALOG,
        audit: (event) => audit.push(JSON.stringify(event)),
      }),
      calls: recorded.calls,
      audit,
      bindings: seeded.bindings,
    };
  })();
}

function assertNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(SERVER_AUTHORIZATION);
  expect(text).not.toContain("server-held-ov-key");
  expect(text).not.toContain(ATTACKER_AUTHORIZATION);
  expect(text).not.toContain("stolen-key");
  expect(text).not.toContain("secret:ov-");
}

test("G2 tracer catalog only classifies find and resources as data-plane", () => {
  expect(G2_TRACER_DATA_PLANE_ROUTES).toEqual([
    { method: "POST", path: "/api/v1/search/find", classification: "data-plane" },
    { method: "POST", path: "/api/v1/resources", classification: "data-plane" },
  ]);
  const dataPlane = G2_TRACER_ROUTE_CATALOG.filter(
    (entry) => entry.classification === "data-plane",
  );
  expect(new Set(dataPlane.map((entry) => `${entry.method} ${entry.path}`))).toEqual(
    new Set(G2_TRACER_DATA_PLANE_ROUTES.map((entry) => `${entry.method} ${entry.path}`)),
  );
  expect(G2_TRACER_ROUTE_CATALOG.length).toBe(PINNED_OPENVIKING_ROUTES.length);
  expect(G2_TRACER_ROUTE_CATALOG.filter((entry) => entry.classification === "denied").length).toBe(
    PINNED_OPENVIKING_ROUTES.length - 2,
  );
});

test("catalog denied routes never reach the runtime client", async () => {
  const { gateway, calls } = await createReadyGateway();
  const denied = G2_TRACER_ROUTE_CATALOG.filter((entry) => entry.classification === "denied");
  expect(denied.length).toBeGreaterThan(80);

  for (const route of denied) {
    const before = calls.length;
    const result = await gateway.forward(OWNER, {
      workspaceId: WORKSPACE_ID,
      method: route.method,
      path: materializePath(route.path),
      headers: SMUGGLED_HEADERS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("route_denied");
    expect(calls.length).toBe(before);
    assertNoSecrets(result);
  }
  expect(calls).toEqual([]);
});

test("unknown routes never reach the runtime client", async () => {
  const { gateway, calls } = await createReadyGateway();
  for (const route of [
    { method: "POST", path: "/api/v1/newly-invented" },
    { method: "GET", path: "/not-in-catalog" },
    { method: "DELETE", path: "/root" },
    { method: "POST", path: "/api/v2/search/find" },
  ]) {
    const result = await gateway.forward(OWNER, {
      workspaceId: WORKSPACE_ID,
      ...route,
      headers: SMUGGLED_HEADERS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("route_denied");
    assertNoSecrets(result);
  }
  expect(calls).toEqual([]);
});

test("hidden admin bot, /mcp, /console/*, and /debug/* are denied one by one without runtime calls", async () => {
  const { gateway, calls } = await createReadyGateway();
  const probes = [
    { method: "GET", path: "/api/v1/admin/bot/capabilities" },
    { method: "GET", path: "/api/v1/admin/accounts/acct-ws-a/bot/connections" },
    { method: "POST", path: "/api/v1/admin/accounts/acct-ws-a/bot/connections" },
    { method: "GET", path: "/api/v1/admin/accounts/acct-ws-a/bot/connections/conn-1" },
    { method: "PATCH", path: "/api/v1/admin/accounts/acct-ws-a/bot/connections/conn-1" },
    { method: "DELETE", path: "/api/v1/admin/accounts/acct-ws-a/bot/connections/conn-1" },
    {
      method: "POST",
      path: "/api/v1/admin/accounts/acct-ws-a/bot/connections/conn-1/credentials",
    },
    {
      method: "POST",
      path: "/api/v1/admin/accounts/acct-ws-a/bot/connections/conn-1/verifications",
    },
    {
      method: "GET",
      path: "/api/v1/admin/accounts/acct-ws-a/bot/onboarding-runs",
    },
    { method: "GET", path: "/mcp" },
    { method: "POST", path: "/mcp" },
    { method: "DELETE", path: "/mcp" },
    { method: "GET", path: "/api/v1/console/dashboard/summary" },
    { method: "GET", path: "/api/v1/console/tokens" },
    { method: "GET", path: "/api/v1/console/context-commits" },
    { method: "GET", path: "/api/v1/console/audit" },
    { method: "GET", path: "/api/v1/debug/health" },
    { method: "GET", path: "/api/v1/debug/vector/scroll" },
    { method: "GET", path: "/api/v1/debug/vector/count" },
  ];

  for (const route of probes) {
    const before = calls.length;
    const result = await gateway.forward(OWNER, {
      workspaceId: WORKSPACE_ID,
      ...route,
    });
    expect(result).toEqual({
      ok: false,
      failure: sanitizeOpenVikingTransportFailure("route_denied"),
    });
    expect(calls.length).toBe(before);
  }
  expect(calls).toEqual([]);
});

test("Owner/Admin/member/Agent/Memory Agent/projection worker permission matrix", async () => {
  const { gateway, calls } = await createReadyGateway();
  const matrix: Array<{
    actor: CoforgeMemoryActor;
    find: boolean;
    write: boolean;
  }> = [
    { actor: OWNER, find: true, write: true },
    { actor: ADMIN, find: true, write: true },
    { actor: MEMBER, find: true, write: true },
    { actor: AGENT, find: true, write: true },
    { actor: MEMORY_AGENT, find: true, write: false },
    { actor: PROJECTION_WORKER, find: false, write: false },
  ];

  for (const row of matrix) {
    const find = await gateway.forward(row.actor, FIND);
    expect(find.ok).toBe(row.find);
    if (!row.find && !find.ok) expect(find.failure.code).toBe("capability_denied");

    const write = await gateway.forward(row.actor, RESOURCES_WRITE);
    expect(write.ok).toBe(row.write);
    if (!row.write && !write.ok) expect(write.failure.code).toBe("capability_denied");
    assertNoSecrets(find);
    assertNoSecrets(write);
  }

  expect(calls).toHaveLength(9);
});

test("Memory Agent mutation is denied and never reaches the runtime client", async () => {
  const { gateway, calls } = await createReadyGateway();
  const result = await gateway.forward(MEMORY_AGENT, RESOURCES_WRITE);
  expect(result).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("capability_denied"),
  });
  expect(calls).toEqual([]);
});

test("unready workspace is rejected before the runtime client is called", async () => {
  const profiles = createInMemoryWorkspaceMemoryProfileStore();
  const bindings = createInMemoryOpenVikingBindingStore();
  const seed = createDefaultWorkspaceMemoryProfile(WORKSPACE_ID);
  const selected = applyWorkspaceMemoryCommand(
    seed,
    { type: "select_desired", desired: "openviking", at: NOW },
    { prototypeEnabled: true },
  );
  expect(selected.ok).toBe(true);
  if (selected.ok) {
    expect(await saveProfileTransition(profiles, seed, selected.profile)).toBe("saved");
    expect(selected.profile.observed).toBe("provisioning");
  }
  const recorded = recordingRuntime();
  const gateway = createOpenVikingPolicyGateway({
    profiles,
    bindings,
    runtime: recorded.runtime,
    resolveAuthorization: async () => SERVER_AUTHORIZATION,
  });
  const result = await gateway.forward(OWNER, FIND);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.code).toBe("workspace_not_ready");
  expect(recorded.calls).toEqual([]);
  assertNoSecrets(result);

  const off = createOpenVikingPolicyGateway({
    profiles: createInMemoryWorkspaceMemoryProfileStore(),
    bindings: createInMemoryOpenVikingBindingStore(),
    runtime: recorded.runtime,
    resolveAuthorization: async () => SERVER_AUTHORIZATION,
  });
  const offResult = await off.forward(OWNER, FIND);
  expect(offResult.ok).toBe(false);
  if (!offResult.ok) expect(offResult.failure.code).toBe("workspace_not_ready");
  expect(recorded.calls).toEqual([]);
});

test("caller identity headers are ignored and runtime sees only the mapped server-owned identity", async () => {
  let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
  const { gateway } = await createReadyGateway({
    fetchImpl: async (input, init) => {
      captured = {
        url: String(input),
        headers: headersFrom(init),
        body: String(init?.body ?? ""),
      };
      return Response.json({ results: [{ uri: "viking://resources/doc.md" }] });
    },
  });
  const result = await gateway.forward(MEMBER, {
    ...FIND,
    headers: SMUGGLED_HEADERS,
  });
  expect(result.ok).toBe(true);
  expect(captured?.url).toBe("http://ov.internal:1933/api/v1/search/find");
  expect(captured?.headers).toEqual({
    authorization: SERVER_AUTHORIZATION,
    "content-type": "application/json",
    "x-openviking-account": "acct-ws-a",
    "x-openviking-user": "user:u-3",
    "x-openviking-role": "user",
  });
  expect(captured?.headers.authorization).not.toBe(ATTACKER_AUTHORIZATION);
  expect(captured?.headers["x-openviking-user"]).not.toBe("root");
  if (result.ok) {
    expect(await new Response(result.response.body).text()).toBe(
      JSON.stringify({ results: [{ uri: "viking://resources/doc.md" }] }),
    );
    expect(result.response.status).toBe(200);
    expect(JSON.stringify(result.response.headers)).not.toContain(SERVER_AUTHORIZATION);
  }
  assertNoSecrets(result);
});

test("authorized read and write round-trip through the gateway without exposing credentials", async () => {
  const seen: string[] = [];
  const audit: string[] = [];
  const { gateway } = await createReadyGateway({
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      seen.push(`${init?.method ?? "GET"} ${path}`);
      const headers = headersFrom(init);
      expect(headers.authorization).toBe(SERVER_AUTHORIZATION);
      expect(headers["x-openviking-account"]).toBe("acct-ws-a");
      if (path === "/api/v1/search/find") {
        return Response.json({ results: [{ uri: "viking://resources/doc.md" }] });
      }
      if (path === "/api/v1/resources") {
        return Response.json({ uri: "viking://resources/notes/alpha.md" }, { status: 201 });
      }
      return new Response("unexpected-route", { status: 500 });
    },
    audit,
  });

  const read = await gateway.forward(OWNER, FIND);
  const write = await gateway.forward(MEMBER, RESOURCES_WRITE);
  expect(read.ok).toBe(true);
  expect(write.ok).toBe(true);
  if (read.ok) {
    expect(read.response.status).toBe(200);
    expect(await new Response(read.response.body).text()).toContain("viking://resources/doc.md");
  }
  if (write.ok) {
    expect(write.response.status).toBe(201);
    expect(await new Response(write.response.body).text()).toContain(
      "viking://resources/notes/alpha.md",
    );
  }
  expect(seen).toEqual(["POST /api/v1/search/find", "POST /api/v1/resources"]);
  expect(audit.join("\n")).not.toContain(SERVER_AUTHORIZATION);
  expect(audit.join("\n")).not.toContain("secret:ov-");
  assertNoSecrets(read);
  assertNoSecrets(write);
  assertNoSecrets(audit);
});

test("thin HTTP adapter composes actor + gateway and does not forward denied routes", async () => {
  const { gateway, calls } = await createReadyGateway();
  const denied = await handleOpenVikingGatewayRequest({
    actor: OWNER,
    request: new Request("http://web.local/api/openviking/ws-a/mcp", {
      method: "POST",
      headers: SMUGGLED_HEADERS,
      body: "{}",
    }),
    workspaceId: WORKSPACE_ID,
    ovPath: "/mcp",
    gateway,
  });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual(sanitizeOpenVikingTransportFailure("route_denied"));
  expect(calls).toEqual([]);

  let capturedPath = "";
  const { gateway: live } = await createReadyGateway({
    fetchImpl: async (input) => {
      capturedPath = new URL(String(input)).pathname;
      return Response.json({ results: [] });
    },
  });
  const allowed = await handleOpenVikingGatewayRequest({
    actor: OWNER,
    request: new Request("http://web.local/api/openviking/ws-a/api/v1/search/find", {
      method: "POST",
      headers: SMUGGLED_HEADERS,
      body: FIND.body as string,
    }),
    workspaceId: WORKSPACE_ID,
    ovPath: "/api/v1/search/find",
    gateway: live,
  });
  expect(allowed.status).toBe(200);
  expect(capturedPath).toBe("/api/v1/search/find");
  const payload = await allowed.json();
  expect(payload).toEqual({ results: [] });
  expect(JSON.stringify(payload)).not.toContain(SERVER_AUTHORIZATION);
  expect(allowed.headers.get("authorization")).toBeNull();
});

test("the TanStack OpenViking proxy route stays a thin composition", async () => {
  const text = await Bun.file(
    new URL("../../routes/api/openviking/$workspaceId/$.ts", import.meta.url),
  ).text();
  expect(text).toMatch(/createFileRoute\("\/api\/openviking\/\$workspaceId\/\$"\)/);
  expect(text).toMatch(/handleOpenVikingProxyRoute|handleOpenVikingGatewayRequest/);
  expect(text).not.toMatch(/decideRoutePolicy|createOpenVikingRuntimeClient|mapMemoryActor/);
  expect(text).not.toMatch(/PINNED_OPENVIKING_ROUTES|G2_TRACER_ROUTE_CATALOG/);
});
