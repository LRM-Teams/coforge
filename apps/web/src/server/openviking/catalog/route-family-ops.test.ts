import { expect, test } from "bun:test";
import {
  mapMemoryActor,
  type CoforgeMemoryActor,
  type GatewayRouteClassification,
} from "../contract";
import { PINNED_OPENVIKING_ROUTES } from "../route-catalog";
import {
  DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  decideRoutePolicy,
  sanitizeOpenVikingTransportFailure,
} from "../route-policy";
import {
  OPS_FAMILY_GATEWAY_POLICIES,
  ROUTE_FAMILY_OPS,
  decideOpsFamilyRoute,
  lookupOpsFamilyRoute,
  type OpsFamilyAccessMode,
} from "./route-family-ops";

const BINDING = { accountId: "acct-ws-a", serviceIdentityId: "svc-projection-ws-a" };

const ACTORS = {
  owner: { kind: "owner", userId: "u-owner" } as const,
  admin: { kind: "admin", userId: "u-admin" } as const,
  member: { kind: "member", userId: "u-member" } as const,
  agent: { kind: "agent", agentId: "ag-1" } as const,
  memory_agent: { kind: "memory_agent", agentId: "mem-1" } as const,
  projection_worker: { kind: "projection_worker" } as const,
} satisfies Record<CoforgeMemoryActor["kind"], CoforgeMemoryActor>;

const ALL_ACTOR_KINDS = Object.keys(ACTORS) as Array<CoforgeMemoryActor["kind"]>;

const OPS_PINNED_FAMILIES = new Set(["task", "watch", "snapshot", "pack", "observer", "stats"]);
const OPS_EXTRA_KEYS = new Set(["POST /api/v1/content/reindex", "POST /api/v1/system/consistency"]);

const EXPECTED_CLASSIFICATION: ReadonlyArray<{
  method: string;
  path: string;
  classification: GatewayRouteClassification;
  accessMode: OpsFamilyAccessMode;
  allowedActors: readonly CoforgeMemoryActor["kind"][];
}> = [
  {
    method: "GET",
    path: "/api/v1/tasks",
    classification: "data-plane",
    accessMode: "read",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "GET",
    path: "/api/v1/tasks/{task_id}",
    classification: "data-plane",
    accessMode: "read",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "POST",
    path: "/api/v1/tasks/{task_id}/cancel",
    classification: "data-plane",
    accessMode: "write",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "GET",
    path: "/api/v1/watches",
    classification: "data-plane",
    accessMode: "read",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "GET",
    path: "/api/v1/watches/{task_id}",
    classification: "data-plane",
    accessMode: "read",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "PATCH",
    path: "/api/v1/watches",
    classification: "data-plane",
    accessMode: "write",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "PATCH",
    path: "/api/v1/watches/{task_id}",
    classification: "data-plane",
    accessMode: "write",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "DELETE",
    path: "/api/v1/watches",
    classification: "data-plane",
    accessMode: "write",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "DELETE",
    path: "/api/v1/watches/{task_id}",
    classification: "data-plane",
    accessMode: "write",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "POST",
    path: "/api/v1/watches/trigger",
    classification: "data-plane",
    accessMode: "write",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "POST",
    path: "/api/v1/watches/{task_id}/trigger",
    classification: "data-plane",
    accessMode: "write",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "POST",
    path: "/api/v1/snapshot/commit",
    classification: "data-plane",
    accessMode: "write",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "GET",
    path: "/api/v1/snapshot/log",
    classification: "data-plane",
    accessMode: "read",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "GET",
    path: "/api/v1/snapshot/show",
    classification: "data-plane",
    accessMode: "read",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "GET",
    path: "/api/v1/snapshot/diff",
    classification: "data-plane",
    accessMode: "read",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "POST",
    path: "/api/v1/snapshot/restore",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "GET",
    path: "/api/v1/snapshot/ignore",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "PUT",
    path: "/api/v1/snapshot/ignore",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "DELETE",
    path: "/api/v1/snapshot/ignore",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "POST",
    path: "/api/v1/pack/export",
    classification: "data-plane",
    accessMode: "write",
    allowedActors: ["owner", "admin", "member", "agent"],
  },
  {
    method: "POST",
    path: "/api/v1/pack/import",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "POST",
    path: "/api/v1/pack/backup",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "POST",
    path: "/api/v1/pack/restore",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "GET",
    path: "/api/v1/observer/queue",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "GET",
    path: "/api/v1/observer/vikingdb",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "GET",
    path: "/api/v1/observer/models",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "GET",
    path: "/api/v1/observer/lock",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "GET",
    path: "/api/v1/observer/retrieval",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "GET",
    path: "/api/v1/observer/filesystem",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "GET",
    path: "/api/v1/observer/system",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "GET",
    path: "/api/v1/stats/memories",
    classification: "denied",
    accessMode: "none",
    allowedActors: [],
  },
  {
    method: "GET",
    path: "/api/v1/stats/sessions/{session_id}",
    classification: "denied",
    accessMode: "none",
    allowedActors: [],
  },
  {
    method: "POST",
    path: "/api/v1/content/reindex",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
  {
    method: "POST",
    path: "/api/v1/system/consistency",
    classification: "typed-control-only",
    accessMode: "admin",
    allowedActors: ["owner", "admin"],
  },
];

function routeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

function instantiatePath(path: string): string {
  return path.replaceAll("{task_id}", "task-1").replaceAll("{session_id}", "sess-1");
}

function pinnedOpsRoutes() {
  return PINNED_OPENVIKING_ROUTES.filter(
    (route) =>
      OPS_PINNED_FAMILIES.has(route.family) ||
      OPS_EXTRA_KEYS.has(routeKey(route.method, route.path)),
  );
}

test("every G3.3 pinned route is classified exactly once", () => {
  const pinned = pinnedOpsRoutes();
  expect(pinned.length).toBe(EXPECTED_CLASSIFICATION.length);
  expect(ROUTE_FAMILY_OPS).toHaveLength(EXPECTED_CLASSIFICATION.length);

  const keys = ROUTE_FAMILY_OPS.map((entry) => routeKey(entry.method, entry.path));
  expect(new Set(keys).size).toBe(keys.length);

  for (const route of pinned) {
    const expected = EXPECTED_CLASSIFICATION.find(
      (entry) => entry.method === route.method && entry.path === route.path,
    );
    expect(expected).toBeDefined();
    const found = lookupOpsFamilyRoute(route.method, instantiatePath(route.path));
    expect(found?.path).toBe(route.path);
    expect(found?.method).toBe(route.method);
    expect(found?.classification).toBe(expected?.classification);
  }
});

test("each ops-family route has a positive and negative actor decision", () => {
  for (const expected of EXPECTED_CLASSIFICATION) {
    const path = instantiatePath(expected.path);
    const found = lookupOpsFamilyRoute(expected.method, path);
    expect(found).toBeDefined();
    if (!found) continue;
    expect(found.classification).toBe(expected.classification);
    expect(found.accessMode).toBe(expected.accessMode);
    expect([...found.allowedActors]).toEqual([...expected.allowedActors]);
    expect(found.limits.maxRequestBytes).toBeGreaterThan(0);
    expect(found.limits.maxResponseBytes).toBeGreaterThan(0);
    expect(found.limits.timeoutMs).toBeGreaterThan(0);

    if (expected.classification === "data-plane") {
      const allowed = decideOpsFamilyRoute({
        actor: ACTORS.owner,
        method: expected.method,
        path,
      });
      expect(allowed).toEqual({
        ok: true,
        method: expected.method,
        path,
        classification: "data-plane",
      });
      expect(
        decideRoutePolicy({
          method: expected.method,
          path,
          access: "workspace_admin",
          requiredCapability: "write_own_namespace",
          catalog: OPS_FAMILY_GATEWAY_POLICIES,
        }).ok ||
          decideRoutePolicy({
            method: expected.method,
            path,
            access: "workspace_admin",
            requiredCapability: "read_shared",
            catalog: OPS_FAMILY_GATEWAY_POLICIES,
          }).ok,
      ).toBe(true);

      const memoryDenied = decideOpsFamilyRoute({
        actor: ACTORS.memory_agent,
        method: expected.method,
        path,
      });
      expect(memoryDenied.ok).toBe(false);
      if (!memoryDenied.ok) {
        expect(memoryDenied.failure).toEqual(
          sanitizeOpenVikingTransportFailure("capability_denied"),
        );
        expect(memoryDenied.classification).toBe("data-plane");
      }
    } else {
      const ownerGeneric = decideOpsFamilyRoute({
        actor: ACTORS.owner,
        method: expected.method,
        path,
      });
      expect(ownerGeneric.ok).toBe(false);
      if (!ownerGeneric.ok) {
        expect(ownerGeneric.failure).toEqual(sanitizeOpenVikingTransportFailure("route_denied"));
        expect(ownerGeneric.classification).toBe(expected.classification);
      }
      expect(
        decideRoutePolicy({
          method: expected.method,
          path,
          access: "workspace_admin",
          requiredCapability: "admin_workspace",
          catalog: OPS_FAMILY_GATEWAY_POLICIES,
        }),
      ).toEqual({
        ok: false,
        failure: sanitizeOpenVikingTransportFailure("route_denied"),
      });

      const memberDenied = decideOpsFamilyRoute({
        actor: ACTORS.member,
        method: expected.method,
        path,
      });
      expect(memberDenied.ok).toBe(false);
      if (!memberDenied.ok) expect(memberDenied.classification).toBe(expected.classification);
    }
  }
});

test("Memory Agent has no approved reads in the ops family", () => {
  const matrix = EXPECTED_CLASSIFICATION.map((entry) => ({
    method: entry.method,
    path: entry.path,
    memoryAgent: decideOpsFamilyRoute({
      actor: ACTORS.memory_agent,
      method: entry.method,
      path: instantiatePath(entry.path),
    }).ok,
  }));

  expect(matrix.every((row) => row.memoryAgent === false)).toBe(true);
  expect(ROUTE_FAMILY_OPS.every((entry) => !entry.allowedActors.includes("memory_agent"))).toBe(
    true,
  );
  expect(mapMemoryActor({ actor: ACTORS.memory_agent, binding: BINDING }).access).toBe(
    "readonly_shared",
  );
});

test("unknown ops-family paths stay denied for every C1 actor", () => {
  for (const kind of ALL_ACTOR_KINDS) {
    const decision = decideOpsFamilyRoute({
      actor: ACTORS[kind],
      method: "GET",
      path: "/api/v1/ops/invented",
    });
    expect(decision).toEqual({
      ok: false,
      classification: "denied",
      failure: sanitizeOpenVikingTransportFailure("route_denied"),
    });
  }
  expect(lookupOpsFamilyRoute("GET", "/api/v1/stats/unknown")).toBeUndefined();
  expect(lookupOpsFamilyRoute("PUT", "/api/v1/tasks")).toBeUndefined();
});

test("projection worker cannot use ops-family routes", () => {
  for (const expected of EXPECTED_CLASSIFICATION) {
    const decision = decideOpsFamilyRoute({
      actor: ACTORS.projection_worker,
      method: expected.method,
      path: instantiatePath(expected.path),
    });
    expect(decision.ok).toBe(false);
    expect(
      ROUTE_FAMILY_OPS.find((entry) => entry.path === expected.path)?.allowedActors,
    ).not.toContain("projection_worker");
  }
});

test("pack and snapshot streams record limits above the default envelope", () => {
  const show = lookupOpsFamilyRoute("GET", "/api/v1/snapshot/show");
  const diff = lookupOpsFamilyRoute("GET", "/api/v1/snapshot/diff");
  const packExport = lookupOpsFamilyRoute("POST", "/api/v1/pack/export");
  const packBackup = lookupOpsFamilyRoute("POST", "/api/v1/pack/backup");
  expect(show?.responseBody).toBe("bytes");
  expect(diff?.responseBody).toBe("json");
  expect(packExport?.responseBody).toBe("zip");
  expect(packBackup?.responseBody).toBe("zip");
  expect(show?.limits.maxResponseBytes).toBeGreaterThan(
    DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxResponseBytes,
  );
  expect(diff?.limits.maxResponseBytes).toBeGreaterThan(
    DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxResponseBytes,
  );
  expect(packExport?.limits.maxResponseBytes).toBeGreaterThan(
    DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxResponseBytes,
  );
  expect(packBackup?.limits.timeoutMs).toBeGreaterThan(
    DEFAULT_OPENVIKING_TRANSPORT_LIMITS.timeoutMs,
  );

  const stats = lookupOpsFamilyRoute("GET", "/api/v1/stats/memories");
  expect(stats?.classification).toBe("denied");
  expect(stats?.notes).toContain("source-only");
  expect(lookupOpsFamilyRoute("POST", "/api/v1/pack/backup")?.notes).toContain("typed");
  expect(lookupOpsFamilyRoute("POST", "/api/v1/pack/restore")?.notes).toContain("typed");
});
