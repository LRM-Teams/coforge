import { expect, test } from "bun:test";
import type { CoforgeMemoryActor } from "../contract";
import { PINNED_OPENVIKING_ROUTES } from "../route-catalog";
import { classifyOpenVikingRoute, sanitizeOpenVikingTransportFailure } from "../route-policy";
import { createOpenVikingPolicyGateway } from "../policy-gateway.server";
import { createFakeOpenVikingProvisioner, createInMemoryOpenVikingBindingStore } from "../stores";
import { createWorkspaceMemoryProfiles } from "../../workspace-memory/profiles";
import { createWorkspaceMemoryProfileReconciler } from "../../workspace-memory/reconciler";
import {
  createInMemoryWorkspaceIdentityDirectory,
  createProductionMemoryRuntimeProvisioner,
  createPrototypeMemoryRuntimeReadiness,
} from "../../workspace-memory/runtime-provisioner";
import { createInMemoryWorkspaceMemoryProfileStore } from "../../workspace-memory/stores";
import {
  AGGREGATED_OPENVIKING_GATEWAY_CATALOG,
  AGGREGATED_OPENVIKING_ROUTE_CATALOG,
  OpenVikingCatalogOverlapError,
  aggregateOpenVikingRouteCatalog,
  lookupAggregatedRoute,
  summarizeAggregatedCatalog,
  type AggregatedRoutePolicy,
} from "./aggregated-catalog";
import { ADMIN_FAMILY_ROUTES } from "./route-family-admin";
import { CONTENT_FAMILY_ROUTES } from "./route-family-content";
import { MEMORY_SKILL_FAMILY_ROUTES } from "./route-family-memory-skill";
import { ROUTE_FAMILY_OPS } from "./route-family-ops";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const WORKSPACE_ID = "ws-a";
const OWNER: CoforgeMemoryActor = { kind: "owner", userId: "u-1" };
const MEMBER: CoforgeMemoryActor = { kind: "member", userId: "u-3" };
const MEMORY_AGENT: CoforgeMemoryActor = { kind: "memory_agent", agentId: "mem-1" };

function keyOf(method: string, path: string): string {
  return `${method} ${path}`;
}

function materializePath(path: string): string {
  return path.includes("{") ? path.replaceAll(/\{[^/]+\}/g, "sample") : path;
}

/** Inventory §6.2–§6.4 official core read/write minus documented denials. */
const CORE_REACHABLE_KEYS = new Set([
  "POST /api/v1/resources/temp_upload",
  "POST /api/v1/resources",
  "GET /api/v1/fs/ls",
  "GET /api/v1/fs/tree",
  "GET /api/v1/fs/stat",
  "GET /api/v1/fs/attrs",
  "POST /api/v1/fs/attrs/set_tags",
  "POST /api/v1/fs/mkdir",
  "DELETE /api/v1/fs",
  "POST /api/v1/fs/cp",
  "POST /api/v1/fs/mv",
  "GET /api/v1/content/read",
  "GET /api/v1/content/abstract",
  "GET /api/v1/content/overview",
  "GET /api/v1/content/download",
  "POST /api/v1/content/write",
  "POST /api/v1/content/batch-write",
  "POST /api/v1/content/set_tags",
  "POST /api/v1/content/reindex",
  "POST /api/v1/search/find",
  "POST /api/v1/search/search",
  "POST /api/v1/search/grep",
  "POST /api/v1/search/glob",
  "GET /api/v1/skills",
  "POST /api/v1/skills",
  "POST /api/v1/skills/find",
  "POST /api/v1/skills/validate",
  "GET /api/v1/skills/{skill_name}",
  "PUT /api/v1/skills/{skill_name}",
  "DELETE /api/v1/skills/{skill_name}",
  "POST /api/v1/sessions",
  "GET /api/v1/sessions",
  "GET /api/v1/sessions/{session_id}",
  "PATCH /api/v1/sessions/{session_id}/config",
  "GET /api/v1/sessions/{session_id}/tool-results",
  "GET /api/v1/sessions/{session_id}/tool-results/{tool_result_id}",
  "GET /api/v1/sessions/{session_id}/tool-results/{tool_result_id}/search",
  "GET /api/v1/sessions/{session_id}/context",
  "GET /api/v1/sessions/{session_id}/archives/{archive_id}",
  "DELETE /api/v1/sessions/{session_id}",
  "POST /api/v1/sessions/{session_id}/commit",
  "POST /api/v1/sessions/{session_id}/extract",
  "POST /api/v1/sessions/{session_id}/messages",
  "POST /api/v1/sessions/{session_id}/messages/batch",
  "POST /api/v1/sessions/{session_id}/used",
  "GET /api/v1/agent-evolution/experiences/trajectories",
  "GET /api/v1/agent-evolution/experiences/outcomes",
  "POST /api/v1/compile",
  "GET /api/v1/compile/capabilities",
  "GET /api/v1/compile/submissions/{key}",
  "GET /api/v1/tasks",
  "GET /api/v1/tasks/{task_id}",
  "POST /api/v1/tasks/{task_id}/cancel",
  "GET /api/v1/watches",
  "GET /api/v1/watches/{task_id}",
  "PATCH /api/v1/watches",
  "PATCH /api/v1/watches/{task_id}",
  "DELETE /api/v1/watches",
  "DELETE /api/v1/watches/{task_id}",
  "POST /api/v1/watches/trigger",
  "POST /api/v1/watches/{task_id}/trigger",
  "POST /api/v1/snapshot/commit",
  "GET /api/v1/snapshot/log",
  "POST /api/v1/snapshot/restore",
  "GET /api/v1/snapshot/show",
  "GET /api/v1/snapshot/diff",
  "GET /api/v1/snapshot/ignore",
  "PUT /api/v1/snapshot/ignore",
  "DELETE /api/v1/snapshot/ignore",
  "POST /api/v1/pack/export",
  "POST /api/v1/pack/import",
  "POST /api/v1/pack/backup",
  "POST /api/v1/pack/restore",
  "GET /api/v1/observer/queue",
  "GET /api/v1/observer/vikingdb",
  "GET /api/v1/observer/models",
  "GET /api/v1/observer/lock",
  "GET /api/v1/observer/retrieval",
  "GET /api/v1/observer/filesystem",
  "GET /api/v1/observer/system",
  "POST /api/v1/system/consistency",
  "GET /api/v1/acl",
  "PUT /api/v1/acl",
  "DELETE /api/v1/acl",
  "POST /api/v1/acl/grant",
  "POST /api/v1/acl/revoke",
  "GET /api/v1/admin/accounts/{account_id}/configuration",
  "PATCH /api/v1/admin/accounts/{account_id}/configuration",
  "GET /api/v1/admin/accounts/{account_id}/memory-templates",
  "GET /api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}",
  "PUT /api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}",
  "DELETE /api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}",
  "POST /api/v1/admin/accounts/{account_id}/users",
  "GET /api/v1/admin/accounts/{account_id}/users",
  "GET /api/v1/admin/accounts/{account_id}/users/{user_id}/settings",
  "PATCH /api/v1/admin/accounts/{account_id}/users/{user_id}/settings",
  "DELETE /api/v1/admin/accounts/{account_id}/users/{user_id}",
  "PUT /api/v1/admin/accounts/{account_id}/users/{user_id}/role",
  "POST /api/v1/admin/accounts/{account_id}/users/{user_id}/key",
  "POST /api/v1/admin/accounts/{account_id}/groups",
  "GET /api/v1/admin/accounts/{account_id}/groups",
  "DELETE /api/v1/admin/accounts/{account_id}/groups/{group_id}",
  "GET /api/v1/admin/accounts/{account_id}/groups/{group_id}/members",
  "PUT /api/v1/admin/accounts/{account_id}/groups/{group_id}/members/{user_id}",
  "DELETE /api/v1/admin/accounts/{account_id}/groups/{group_id}/members/{user_id}",
  "GET /api/v1/privacy-configs",
  "GET /api/v1/privacy-configs/{category}",
  "GET /api/v1/privacy-configs/{category}/{target_key}",
  "GET /api/v1/privacy-configs/{category}/{target_key}/versions",
  "GET /api/v1/privacy-configs/{category}/{target_key}/versions/{version}",
  "POST /api/v1/privacy-configs/{category}/{target_key}",
  "POST /api/v1/privacy-configs/{category}/{target_key}/activate",
]);

const INTENTIONAL_DENIALS = new Set([
  "POST /api/v1/search/recall",
  "GET /api/v1/stats/memories",
  "GET /api/v1/stats/sessions/{session_id}",
]);

async function seedReadyWorkspace() {
  const profiles = createInMemoryWorkspaceMemoryProfileStore();
  const bindings = createInMemoryOpenVikingBindingStore();
  const provisioner = createProductionMemoryRuntimeProvisioner({
    openviking: createFakeOpenVikingProvisioner(),
    bindings,
    identities: createInMemoryWorkspaceIdentityDirectory([OWNER, MEMBER, MEMORY_AGENT]),
    readiness: createPrototypeMemoryRuntimeReadiness(),
  });
  const profileApi = createWorkspaceMemoryProfiles({
    store: profiles,
    gate: { prototypeEnabled: true },
  });
  const reconciler = createWorkspaceMemoryProfileReconciler({ store: profiles, provisioner });
  const selected = await profileApi.selectDesired({
    workspaceId: WORKSPACE_ID,
    desired: "openviking",
    at: NOW,
  });
  expect(selected.ok).toBe(true);
  const ready = await reconciler.reconcile(WORKSPACE_ID);
  expect(ready.ok).toBe(true);
  return { profiles, bindings };
}

test("every pinned D3 route is classified exactly once in the aggregated catalog", () => {
  const seen = new Map<string, AggregatedRoutePolicy>();
  for (const route of AGGREGATED_OPENVIKING_ROUTE_CATALOG) {
    const key = keyOf(route.method, route.path);
    expect(seen.has(key)).toBe(false);
    seen.set(key, route);
  }
  expect(seen.size).toBe(PINNED_OPENVIKING_ROUTES.length);
  expect(AGGREGATED_OPENVIKING_GATEWAY_CATALOG).toHaveLength(PINNED_OPENVIKING_ROUTES.length);

  for (const pinned of PINNED_OPENVIKING_ROUTES) {
    const match = seen.get(keyOf(pinned.method, pinned.path));
    expect(match).toBeDefined();
    if (!match) continue;
    expect(match.method).toBe(pinned.method);
    expect(match.path).toBe(pinned.path);
    expect(["data-plane", "typed-control-only", "denied"]).toContain(match.classification);
  }
});

test("duplicate family claims and overlapping patterns fail aggregation", () => {
  const reindex = AGGREGATED_OPENVIKING_ROUTE_CATALOG.find(
    (route) => route.method === "POST" && route.path === "/api/v1/content/reindex",
  );
  expect(reindex?.source).toBe("ops");
  expect(reindex?.family).toBe("reindex");
  expect(
    CONTENT_FAMILY_ROUTES.some(
      (route) => route.method === "POST" && route.path === "/api/v1/content/reindex",
    ),
  ).toBe(false);
  expect(
    ROUTE_FAMILY_OPS.filter(
      (route) => route.method === "POST" && route.path === "/api/v1/system/consistency",
    ),
  ).toHaveLength(1);

  const find = AGGREGATED_OPENVIKING_ROUTE_CATALOG.find(
    (route) => route.method === "POST" && route.path === "/api/v1/search/find",
  );
  expect(find).toBeDefined();
  if (!find) throw new Error("find route missing");

  expect(() =>
    aggregateOpenVikingRouteCatalog({
      familyRoutes: [find, { ...find, source: "ops", family: "reindex" }],
    }),
  ).toThrow(OpenVikingCatalogOverlapError);

  expect(() =>
    aggregateOpenVikingRouteCatalog({
      familyRoutes: [
        find,
        {
          ...find,
          path: "/api/v1/search/{name}",
          source: "ops",
          family: "search",
        },
      ],
    }),
  ).toThrow(OpenVikingCatalogOverlapError);
});

test("unknown and future routes stay denied", () => {
  for (const route of [
    { method: "POST", path: "/api/v1/newly-invented" },
    { method: "GET", path: "/not-in-catalog" },
    { method: "DELETE", path: "/root" },
    { method: "POST", path: "/api/v2/search/find" },
    { method: "GET", path: "/api/v1/search/find" },
  ]) {
    expect(classifyOpenVikingRoute(route, AGGREGATED_OPENVIKING_GATEWAY_CATALOG)).toBe("denied");
    expect(lookupAggregatedRoute(route.method, route.path)).toBeUndefined();
  }
});

test("complete OpenViking core read/write paths are reachable as data-plane or typed-control", () => {
  const byKey = new Map(
    AGGREGATED_OPENVIKING_ROUTE_CATALOG.map((route) => [keyOf(route.method, route.path), route]),
  );

  for (const key of CORE_REACHABLE_KEYS) {
    const route = byKey.get(key);
    expect(route).toBeDefined();
    if (!route) continue;
    expect(["data-plane", "typed-control-only"]).toContain(route.classification);
  }

  for (const key of INTENTIONAL_DENIALS) {
    expect(byKey.get(key)?.classification).toBe("denied");
  }

  const unexpectedDenied = AGGREGATED_OPENVIKING_ROUTE_CATALOG.filter(
    (route) =>
      CORE_REACHABLE_KEYS.has(keyOf(route.method, route.path)) && route.classification === "denied",
  );
  expect(unexpectedDenied).toEqual([]);
});

test("family sum minus the resolved reindex duplicate plus residuals equals the pinned catalog", () => {
  const familySum =
    CONTENT_FAMILY_ROUTES.length +
    MEMORY_SKILL_FAMILY_ROUTES.length +
    ROUTE_FAMILY_OPS.length +
    ADMIN_FAMILY_ROUTES.length;
  const summary = summarizeAggregatedCatalog();
  expect(familySum).toBe(125);
  expect(summary.total).toBe(PINNED_OPENVIKING_ROUTES.length);
  expect(summary.total).toBe(192);
  expect(summary.dataPlane).toBe(63);
  expect(summary.typedControlOnly).toBe(49);
  expect(summary.denied).toBe(80);
  expect(summary.total - familySum).toBe(67);
  expect(
    AGGREGATED_OPENVIKING_ROUTE_CATALOG.filter((route) => route.source === "residual"),
  ).toHaveLength(67);
});

test("gateway default catalog forwards core data-plane reads and keeps residual/unknown denied", async () => {
  const { profiles, bindings } = await seedReadyWorkspace();
  const calls: Array<{ method: string; path: string }> = [];
  const gateway = createOpenVikingPolicyGateway({
    profiles,
    bindings,
    runtime: {
      async request(input) {
        calls.push({ method: input.method, path: input.path });
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
    resolveAuthorization: async () => "Bearer server-held-ov-key",
  });

  const read = await gateway.forward(OWNER, {
    workspaceId: WORKSPACE_ID,
    method: "GET",
    path: "/api/v1/content/read",
  });
  expect(read.ok).toBe(true);

  const find = await gateway.forward(MEMBER, {
    workspaceId: WORKSPACE_ID,
    method: "POST",
    path: "/api/v1/search/find",
    body: "{}",
  });
  expect(find.ok).toBe(true);

  const writeDenied = await gateway.forward(MEMORY_AGENT, {
    workspaceId: WORKSPACE_ID,
    method: "POST",
    path: "/api/v1/resources",
    body: "{}",
  });
  expect(writeDenied).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("capability_denied"),
  });

  const residual = await gateway.forward(OWNER, {
    workspaceId: WORKSPACE_ID,
    method: "GET",
    path: "/mcp",
  });
  expect(residual).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("route_denied"),
  });

  const future = await gateway.forward(OWNER, {
    workspaceId: WORKSPACE_ID,
    method: "POST",
    path: "/api/v1/newly-invented",
  });
  expect(future).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("route_denied"),
  });

  const typed = await gateway.forward(OWNER, {
    workspaceId: WORKSPACE_ID,
    method: "POST",
    path: "/api/v1/content/reindex",
  });
  expect(typed).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("route_denied"),
  });

  expect(calls).toEqual([
    { method: "GET", path: "/api/v1/content/read" },
    { method: "POST", path: "/api/v1/search/find" },
  ]);

  const deniedResiduals = AGGREGATED_OPENVIKING_ROUTE_CATALOG.filter(
    (route) => route.classification === "denied",
  );
  expect(deniedResiduals.length).toBeGreaterThan(70);
  for (const route of deniedResiduals) {
    const before = calls.length;
    const result = await gateway.forward(OWNER, {
      workspaceId: WORKSPACE_ID,
      method: route.method,
      path: materializePath(route.path),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("route_denied");
    expect(calls.length).toBe(before);
  }
});

test("unready workspace is still rejected before any aggregated-catalog forward", async () => {
  const profiles = createInMemoryWorkspaceMemoryProfileStore();
  const bindings = createInMemoryOpenVikingBindingStore();
  const calls: string[] = [];
  const gateway = createOpenVikingPolicyGateway({
    profiles,
    bindings,
    runtime: {
      async request() {
        calls.push("runtime");
        throw new Error("unreachable");
      },
    },
    resolveAuthorization: async () => "Bearer server-held-ov-key",
  });
  const result = await gateway.forward(OWNER, {
    workspaceId: WORKSPACE_ID,
    method: "POST",
    path: "/api/v1/search/find",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.code).toBe("workspace_not_ready");
  expect(calls).toEqual([]);
});
