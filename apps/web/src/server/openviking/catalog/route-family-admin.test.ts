import { expect, test } from "bun:test";
import {
  mapMemoryActor,
  type CoforgeMemoryActor,
  type GatewayRouteClassification,
} from "../contract";
import { PINNED_OPENVIKING_ROUTES } from "../route-catalog";
import {
  DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  actorHasCapability,
  decideRoutePolicy,
  type GatewayCapability,
} from "../route-policy";
import {
  ADMIN_FAMILY_PINNED_FAMILIES,
  ADMIN_FAMILY_ROUTES,
  adminFamilyAllowsActor,
  adminFamilyMemoryAgentMayRead,
  classifyAdminFamilyRoute,
  lookupAdminFamilyRoute,
  type AdminFamilyRoutePolicy,
} from "./route-family-admin";

const ACTOR_KINDS = [
  "owner",
  "admin",
  "member",
  "agent",
  "memory_agent",
  "projection_worker",
] as const satisfies readonly CoforgeMemoryActor["kind"][];

const WORKSPACE_ADMINS: readonly CoforgeMemoryActor["kind"][] = ["owner", "admin"];
const NON_ADMINS = ACTOR_KINDS.filter((kind) => !WORKSPACE_ADMINS.includes(kind));

type ExpectedDisposition = {
  method: string;
  path: string;
  family: "acl" | "admin" | "privacy";
  classification: GatewayRouteClassification;
  requiredCapability: GatewayCapability | null;
  allowedActors: readonly CoforgeMemoryActor["kind"][];
  requestBody: "none" | "json";
  responseStream: false;
  reason?: string;
};

const TYPED_WORKSPACE_ADMIN = {
  classification: "typed-control-only",
  requiredCapability: "admin_workspace",
  allowedActors: WORKSPACE_ADMINS,
  responseStream: false,
} as const;

const DENIED_ALL = {
  classification: "denied",
  requiredCapability: null,
  allowedActors: [],
  responseStream: false,
} as const;

/** Independent inventory disposition for D3 §6.5. Not derived from the manifest. */
const EXPECTED: readonly ExpectedDisposition[] = [
  {
    method: "GET",
    path: "/api/v1/acl",
    family: "acl",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "PUT",
    path: "/api/v1/acl",
    family: "acl",
    requestBody: "json",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "DELETE",
    path: "/api/v1/acl",
    family: "acl",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "POST",
    path: "/api/v1/acl/grant",
    family: "acl",
    requestBody: "json",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "POST",
    path: "/api/v1/acl/revoke",
    family: "acl",
    requestBody: "json",
    ...TYPED_WORKSPACE_ADMIN,
  },

  {
    method: "GET",
    path: "/api/v1/admin/configuration",
    family: "admin",
    requestBody: "none",
    reason: "root/cross-account cluster configuration; requires typed operations channel",
    ...DENIED_ALL,
  },
  {
    method: "PATCH",
    path: "/api/v1/admin/configuration",
    family: "admin",
    requestBody: "json",
    reason: "root/cross-account cluster configuration; requires typed operations channel",
    ...DENIED_ALL,
  },
  {
    method: "GET",
    path: "/api/v1/admin/accounts/{account_id}/configuration",
    family: "admin",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "PATCH",
    path: "/api/v1/admin/accounts/{account_id}/configuration",
    family: "admin",
    requestBody: "json",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "GET",
    path: "/api/v1/admin/agent-evolution",
    family: "admin",
    requestBody: "none",
    reason: "deprecated; denied rather than generic or typed-control access",
    ...DENIED_ALL,
  },
  {
    method: "PUT",
    path: "/api/v1/admin/agent-evolution",
    family: "admin",
    requestBody: "json",
    reason: "deprecated; denied rather than generic or typed-control access",
    ...DENIED_ALL,
  },
  {
    method: "GET",
    path: "/api/v1/admin/accounts/{account_id}/settings",
    family: "admin",
    requestBody: "none",
    reason: "deprecated; denied rather than generic or typed-control access",
    ...DENIED_ALL,
  },
  {
    method: "PATCH",
    path: "/api/v1/admin/accounts/{account_id}/settings",
    family: "admin",
    requestBody: "json",
    reason: "deprecated; denied rather than generic or typed-control access",
    ...DENIED_ALL,
  },
  {
    method: "GET",
    path: "/api/v1/admin/accounts/{account_id}/memory-templates",
    family: "admin",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "GET",
    path: "/api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}",
    family: "admin",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "PUT",
    path: "/api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}",
    family: "admin",
    requestBody: "json",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "DELETE",
    path: "/api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}",
    family: "admin",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "POST",
    path: "/api/v1/admin/accounts",
    family: "admin",
    requestBody: "json",
    reason: "root/cross-account account create; requires typed provisioning channel",
    ...DENIED_ALL,
  },
  {
    method: "GET",
    path: "/api/v1/admin/accounts",
    family: "admin",
    requestBody: "none",
    reason: "root/cross-account account listing; requires typed operations channel",
    ...DENIED_ALL,
  },
  {
    method: "POST",
    path: "/api/v1/admin/migrate",
    family: "admin",
    requestBody: "json",
    reason: "root legacy migration; requires typed operations channel",
    ...DENIED_ALL,
  },
  {
    method: "DELETE",
    path: "/api/v1/admin/accounts/{account_id}",
    family: "admin",
    requestBody: "none",
    reason: "root/cross-account destructive delete; requires typed cleanup channel",
    ...DENIED_ALL,
  },
  {
    method: "POST",
    path: "/api/v1/admin/accounts/{account_id}/users",
    family: "admin",
    requestBody: "json",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "GET",
    path: "/api/v1/admin/accounts/{account_id}/users",
    family: "admin",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "GET",
    path: "/api/v1/admin/accounts/{account_id}/users/{user_id}/settings",
    family: "admin",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "PATCH",
    path: "/api/v1/admin/accounts/{account_id}/users/{user_id}/settings",
    family: "admin",
    requestBody: "json",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "DELETE",
    path: "/api/v1/admin/accounts/{account_id}/users/{user_id}",
    family: "admin",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "PUT",
    path: "/api/v1/admin/accounts/{account_id}/users/{user_id}/role",
    family: "admin",
    requestBody: "json",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "POST",
    path: "/api/v1/admin/accounts/{account_id}/users/{user_id}/key",
    family: "admin",
    requestBody: "json",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "POST",
    path: "/api/v1/admin/accounts/{account_id}/groups",
    family: "admin",
    requestBody: "json",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "GET",
    path: "/api/v1/admin/accounts/{account_id}/groups",
    family: "admin",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "DELETE",
    path: "/api/v1/admin/accounts/{account_id}/groups/{group_id}",
    family: "admin",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "GET",
    path: "/api/v1/admin/accounts/{account_id}/groups/{group_id}/members",
    family: "admin",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "PUT",
    path: "/api/v1/admin/accounts/{account_id}/groups/{group_id}/members/{user_id}",
    family: "admin",
    requestBody: "json",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "DELETE",
    path: "/api/v1/admin/accounts/{account_id}/groups/{group_id}/members/{user_id}",
    family: "admin",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },

  {
    method: "GET",
    path: "/api/v1/privacy-configs",
    family: "privacy",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "GET",
    path: "/api/v1/privacy-configs/{category}",
    family: "privacy",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "GET",
    path: "/api/v1/privacy-configs/{category}/{target_key}",
    family: "privacy",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "GET",
    path: "/api/v1/privacy-configs/{category}/{target_key}/versions",
    family: "privacy",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "GET",
    path: "/api/v1/privacy-configs/{category}/{target_key}/versions/{version}",
    family: "privacy",
    requestBody: "none",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "POST",
    path: "/api/v1/privacy-configs/{category}/{target_key}",
    family: "privacy",
    requestBody: "json",
    ...TYPED_WORKSPACE_ADMIN,
  },
  {
    method: "POST",
    path: "/api/v1/privacy-configs/{category}/{target_key}/activate",
    family: "privacy",
    requestBody: "json",
    ...TYPED_WORKSPACE_ADMIN,
  },
];

function routeKey(route: { method: string; path: string }): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

function materialize(path: string): string {
  return path.includes("{") ? path.replaceAll(/\{[^/]+\}/g, "sample") : path;
}

function sampleActor(kind: CoforgeMemoryActor["kind"]): CoforgeMemoryActor {
  switch (kind) {
    case "owner":
      return { kind, userId: "u-owner" };
    case "admin":
      return { kind, userId: "u-admin" };
    case "member":
      return { kind, userId: "u-member" };
    case "agent":
      return { kind, agentId: "ag-1" };
    case "memory_agent":
      return { kind, agentId: "mem-1" };
    case "projection_worker":
      return { kind };
  }
}

const PINNED_ADMIN_FAMILY = PINNED_OPENVIKING_ROUTES.filter((route) =>
  (ADMIN_FAMILY_PINNED_FAMILIES as readonly string[]).includes(route.family),
);

test("admin family covers every pinned acl, admin, and privacy route exactly once", () => {
  expect(ADMIN_FAMILY_PINNED_FAMILIES).toEqual(["acl", "admin", "privacy"]);
  expect(EXPECTED.map(routeKey).sort()).toEqual(PINNED_ADMIN_FAMILY.map(routeKey).sort());
  expect(ADMIN_FAMILY_ROUTES.map(routeKey).sort()).toEqual(
    PINNED_ADMIN_FAMILY.map(routeKey).sort(),
  );
  expect(new Set(ADMIN_FAMILY_ROUTES.map(routeKey)).size).toBe(ADMIN_FAMILY_ROUTES.length);
  expect(PINNED_ADMIN_FAMILY.every((route) => route.classified === false)).toBe(true);
});

test("each admin-family route has the expected classification, actors, body, and limits", () => {
  expect(ADMIN_FAMILY_ROUTES.filter((route) => route.classification === "data-plane")).toHaveLength(
    0,
  );
  expect(
    ADMIN_FAMILY_ROUTES.filter((route) => route.classification === "typed-control-only"),
  ).toHaveLength(EXPECTED.filter((route) => route.classification === "typed-control-only").length);
  expect(ADMIN_FAMILY_ROUTES.filter((route) => route.classification === "denied")).toHaveLength(
    EXPECTED.filter((route) => route.classification === "denied").length,
  );

  for (const expected of EXPECTED) {
    const found = lookupAdminFamilyRoute(expected.method, expected.path);
    expect(found, routeKey(expected)).toBeDefined();
    if (!found) continue;
    expect(found.method).toBe(expected.method);
    expect(found.path).toBe(expected.path);
    expect(found.family).toBe(expected.family);
    expect(found.classification).toBe(expected.classification);
    expect(found.requiredCapability).toBe(expected.requiredCapability);
    expect(found.allowedActors).toEqual(expected.allowedActors);
    expect(found.requestBody).toBe(expected.requestBody);
    expect(found.responseStream).toBe(false);
    expect(found.limits).toEqual(DEFAULT_OPENVIKING_TRANSPORT_LIMITS);
    if (expected.reason) expect(found.reason).toBe(expected.reason);
    expect(classifyAdminFamilyRoute(expected.method, expected.path)).toBe(expected.classification);
    expect(
      classifyAdminFamilyRoute(expected.method.toLowerCase(), materialize(expected.path)),
    ).toBe(expected.classification);
  }
});

test("typed-control-only routes allow workspace admins and deny every other actor", () => {
  const typed = EXPECTED.filter((route) => route.classification === "typed-control-only");
  expect(typed.length).toBeGreaterThan(0);

  for (const expected of typed) {
    const found = lookupAdminFamilyRoute(expected.method, expected.path);
    expect(found).toBeDefined();
    if (!found) continue;

    for (const kind of WORKSPACE_ADMINS) {
      expect(adminFamilyAllowsActor(found, kind)).toBe(true);
    }
    for (const kind of NON_ADMINS) {
      expect(adminFamilyAllowsActor(found, kind)).toBe(false);
    }

    const generic = decideRoutePolicy({
      method: expected.method,
      path: materialize(expected.path),
      access: "workspace_admin",
      requiredCapability: "admin_workspace",
    });
    expect(generic.ok).toBe(false);
    if (!generic.ok) expect(generic.failure.code).toBe("route_denied");
  }
});

test("denied root, cross-account, and deprecated routes stay denied for every actor", () => {
  const denied = EXPECTED.filter((route) => route.classification === "denied");
  expect(denied.length).toBeGreaterThan(0);

  for (const expected of denied) {
    const found = lookupAdminFamilyRoute(expected.method, expected.path);
    expect(found).toBeDefined();
    if (!found) continue;
    expect(found.reason).toContain("typed");
    if (
      expected.path === "/api/v1/admin/accounts" ||
      expected.path === "/api/v1/admin/configuration"
    ) {
      expect(found.reason).toMatch(/root\/cross-account/);
    }
    for (const kind of ACTOR_KINDS) {
      expect(adminFamilyAllowsActor(found, kind)).toBe(false);
    }
    const generic = decideRoutePolicy({
      method: expected.method,
      path: materialize(expected.path),
      access: "workspace_admin",
      requiredCapability: "admin_workspace",
    });
    expect(generic.ok).toBe(false);
    if (!generic.ok) expect(generic.failure.code).toBe("route_denied");
  }
});

test("Memory Agent has no approved read in the admin family", () => {
  const binding = { accountId: "acct-ws-a", serviceIdentityId: "svc-projection-ws-a" };
  const mapped = mapMemoryActor({ actor: { kind: "memory_agent", agentId: "mem-1" }, binding });
  expect(mapped.access).toBe("readonly_shared");
  expect(actorHasCapability(mapped.access, "admin_workspace")).toBe(false);
  expect(actorHasCapability(mapped.access, "read_shared")).toBe(true);

  expect(ADMIN_FAMILY_ROUTES.length).toBe(EXPECTED.length);
  for (const route of ADMIN_FAMILY_ROUTES) {
    expect(adminFamilyMemoryAgentMayRead(route)).toBe(false);
    expect(adminFamilyAllowsActor(route, "memory_agent")).toBe(false);
    expect(route.allowedActors).not.toContain("memory_agent");
  }
});

test("ordinary actors cannot satisfy admin-family capabilities or cross account scope", () => {
  const binding = { accountId: "acct-ws-a", serviceIdentityId: "svc-projection-ws-a" };
  const accessByKind = Object.fromEntries(
    ACTOR_KINDS.map((kind) => [kind, mapMemoryActor({ actor: sampleActor(kind), binding }).access]),
  );

  expect(actorHasCapability(accessByKind.owner, "admin_workspace")).toBe(true);
  expect(actorHasCapability(accessByKind.admin, "admin_workspace")).toBe(true);
  expect(actorHasCapability(accessByKind.member, "admin_workspace")).toBe(false);
  expect(actorHasCapability(accessByKind.agent, "admin_workspace")).toBe(false);
  expect(actorHasCapability(accessByKind.memory_agent, "admin_workspace")).toBe(false);
  expect(actorHasCapability(accessByKind.projection_worker, "admin_workspace")).toBe(false);

  const foreignUsers = lookupAdminFamilyRoute("GET", "/api/v1/admin/accounts/other-ws/users");
  expect(foreignUsers?.classification).toBe("typed-control-only");
  expect(adminFamilyAllowsActor(foreignUsers as AdminFamilyRoutePolicy, "member")).toBe(false);
  expect(adminFamilyAllowsActor(foreignUsers as AdminFamilyRoutePolicy, "agent")).toBe(false);
  expect(classifyAdminFamilyRoute("GET", "/api/v1/admin/accounts")).toBe("denied");
});

test("unknown admin-family paths and methods remain denied", () => {
  expect(lookupAdminFamilyRoute("GET", "/api/v1/admin/unknown")).toBeUndefined();
  expect(classifyAdminFamilyRoute("GET", "/api/v1/admin/unknown")).toBe("denied");
  expect(classifyAdminFamilyRoute("POST", "/api/v1/acl")).toBe("denied");
  expect(classifyAdminFamilyRoute("GET", "/api/v1/newly-invented")).toBe("denied");
  expect(
    classifyAdminFamilyRoute("DELETE", "/api/v1/admin/accounts/acct-ws-a/bot/connections"),
  ).toBe("denied");

  const unknown = decideRoutePolicy({
    method: "POST",
    path: "/api/v1/admin/unknown",
    access: "workspace_admin",
    requiredCapability: "admin_workspace",
  });
  expect(unknown).toEqual({
    ok: false,
    failure: { code: "route_denied", message: "OpenViking route is not allowed" },
  });
});
