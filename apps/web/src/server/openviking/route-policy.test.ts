import { expect, test } from "bun:test";
import { classifyGatewayRoute, type GatewayRoutePolicy, type OpenVikingAccess } from "./contract";
import { PINNED_OPENVIKING_ROUTES } from "./route-catalog";
import {
  DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  actorHasCapability,
  applyIdentityHeaderPolicy,
  decideRoutePolicy,
  decideTransportSize,
  normalizeOpenVikingPath,
  sanitizeOpenVikingTransportFailure,
} from "./route-policy";

const DATA_PLANE_WRITE: GatewayRoutePolicy = {
  method: "POST",
  path: "/api/v1/content/write",
  classification: "data-plane",
};

const TYPED_DELETE_ACCOUNT: GatewayRoutePolicy = {
  method: "DELETE",
  path: "/api/v1/admin/accounts/{account_id}",
  classification: "typed-control-only",
};

test("unknown and unclassified OpenViking routes are denied", () => {
  const invented = decideRoutePolicy({
    method: "POST",
    path: "/api/v1/newly-invented",
    access: "workspace_admin",
    requiredCapability: "admin_workspace",
  });
  expect(invented).toEqual({
    ok: false,
    failure: {
      code: "route_denied",
      message: "OpenViking route is not allowed",
    },
  });

  const unclassifiedOfficial = decideRoutePolicy({
    method: "GET",
    path: "/api/v1/content/read",
    access: "readonly_shared",
    requiredCapability: "read_shared",
  });
  expect(unclassifiedOfficial).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("route_denied"),
  });

  for (const route of [
    { method: "GET", path: "/mcp" },
    { method: "POST", path: "/mcp" },
    { method: "GET", path: "/api/v1/console/dashboard/summary" },
    { method: "GET", path: "/api/v1/debug/health" },
    { method: "GET", path: "/api/v1/stats/memories" },
    { method: "GET", path: "/api/v1/user-settings/add-locations" },
    { method: "GET", path: "/api/v1/admin/bot/capabilities" },
    { method: "GET", path: "/api/v1/admin/accounts/acct-ws-a/bot/connections" },
  ]) {
    const decision = decideRoutePolicy({
      method: route.method,
      path: route.path,
      access: "workspace_admin",
      requiredCapability: "admin_workspace",
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.failure.code).toBe("route_denied");
  }
});

test("every pinned inventory route stays unclassified and denied", () => {
  expect(PINNED_OPENVIKING_ROUTES.length).toBeGreaterThan(80);
  for (const route of PINNED_OPENVIKING_ROUTES) {
    expect(route.classified).toBe(false);
    expect(
      classifyGatewayRoute({ method: route.method, path: route.path }, [
        {
          method: route.method,
          path: route.path,
          classification: "denied",
        },
      ]),
    ).toBe("denied");
    const path = route.path.includes("{")
      ? route.path.replaceAll(/\{[^/]+\}/g, "sample")
      : route.path;
    const decision = decideRoutePolicy({
      method: route.method,
      path,
      access: "workspace_admin",
      requiredCapability: "admin_workspace",
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.failure.code).toBe("route_denied");
  }
});

test("path normalization rejects encoded traversal and origin escape", () => {
  expect(normalizeOpenVikingPath("/api/v1/content/read")).toEqual({
    ok: true,
    path: "/api/v1/content/read",
  });
  expect(normalizeOpenVikingPath("/api/v1/content/read/")).toEqual({
    ok: true,
    path: "/api/v1/content/read",
  });
  expect(normalizeOpenVikingPath("/health")).toEqual({ ok: true, path: "/health" });

  const rejected = [
    "/api/v1/content/../admin/accounts",
    "/api/v1/content/%2e%2e/admin/accounts",
    "/api/v1/content/%2e%2e%2fadmin",
    "/%252e%252e/admin",
    "/api/v1//content/read",
    "/./api/v1/content/read",
    "/api/v1/content/read%00",
    "http://evil.example/api/v1/content/read",
    "//evil.example/api/v1/content/read",
    "api/v1/content/read",
    "/api/v1/content/read?x=1",
    "/api\\v1\\content\\read",
  ];
  for (const path of rejected) {
    expect(normalizeOpenVikingPath(path)).toEqual({
      ok: false,
      failure: sanitizeOpenVikingTransportFailure("invalid_path"),
    });
  }

  const traversalDecision = decideRoutePolicy({
    method: "GET",
    path: "/api/v1/content/%2e%2e/admin/accounts",
    access: "workspace_admin",
    requiredCapability: "admin_workspace",
  });
  expect(traversalDecision).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("invalid_path"),
  });
});

test("actor access classes grant only their declared capabilities", () => {
  const matrix: Record<OpenVikingAccess, readonly string[]> = {
    workspace_admin: ["admin_workspace", "write_own_namespace", "write_granted", "read_shared"],
    own_namespace: ["write_own_namespace", "read_shared"],
    explicit_grant: ["write_granted", "read_shared"],
    readonly_shared: ["read_shared"],
    projection_only: ["mutate_projection"],
  };
  const capabilities = [
    "admin_workspace",
    "write_own_namespace",
    "write_granted",
    "read_shared",
    "mutate_projection",
  ] as const;

  for (const [access, allowed] of Object.entries(matrix) as [
    OpenVikingAccess,
    readonly string[],
  ][]) {
    for (const capability of capabilities) {
      expect(actorHasCapability(access, capability)).toBe(allowed.includes(capability));
    }
  }

  const catalog = [DATA_PLANE_WRITE];
  expect(
    decideRoutePolicy({
      method: "POST",
      path: "/api/v1/content/write",
      access: "workspace_admin",
      requiredCapability: "write_own_namespace",
      catalog,
    }),
  ).toEqual({
    ok: true,
    method: "POST",
    path: "/api/v1/content/write",
    classification: "data-plane",
  });
  expect(
    decideRoutePolicy({
      method: "POST",
      path: "/api/v1/content/write",
      access: "readonly_shared",
      requiredCapability: "write_own_namespace",
      catalog,
    }),
  ).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("capability_denied"),
  });
  expect(
    decideRoutePolicy({
      method: "POST",
      path: "/api/v1/content/write",
      access: "projection_only",
      requiredCapability: "write_own_namespace",
      catalog,
    }),
  ).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("capability_denied"),
  });
  expect(
    decideRoutePolicy({
      method: "POST",
      path: "/api/v1/content/write",
      access: "projection_only",
      requiredCapability: "mutate_projection",
      catalog,
    }),
  ).toEqual({
    ok: true,
    method: "POST",
    path: "/api/v1/content/write",
    classification: "data-plane",
  });
  expect(
    decideRoutePolicy({
      method: "DELETE",
      path: "/api/v1/admin/accounts/acct-ws-a",
      access: "workspace_admin",
      requiredCapability: "admin_workspace",
      catalog: [TYPED_DELETE_ACCOUNT],
    }),
  ).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("route_denied"),
  });
});

test("identity and account header denylist is applied before server identity is attached", () => {
  const headers = applyIdentityHeaderPolicy({
    incoming: {
      Authorization: "Bearer attacker-key",
      "X-API-Key": "stolen-key",
      "X-OpenViking-Account": "acct-evil",
      "X-OpenViking-User": "root",
      "X-OpenViking-Role": "root",
      "X-OpenViking-Actor-Peer": "peer-user",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    serverIdentity: {
      accountId: "acct-ws-a",
      userId: "user:u-1",
      role: "admin",
      authorization: "Bearer server-held-key",
    },
  });
  expect(headers).toEqual({
    accept: "application/json",
    authorization: "Bearer server-held-key",
    "content-type": "application/json",
    "x-openviking-account": "acct-ws-a",
    "x-openviking-user": "user:u-1",
    "x-openviking-role": "admin",
  });
  expect(headers["x-api-key"]).toBeUndefined();
  expect(headers["x-openviking-actor-peer"]).toBeUndefined();

  const serviceHeaders = applyIdentityHeaderPolicy({
    incoming: { "x-openviking-role": "root" },
    serverIdentity: {
      accountId: "acct-ws-a",
      userId: "svc-projection-ws-a",
      role: "service",
      authorization: "Bearer server-held-service",
    },
  });
  expect(serviceHeaders["x-openviking-role"]).toBe("user");
  expect(serviceHeaders.authorization).toBe("Bearer server-held-service");
});

test("body and stream size limits fail closed at the default envelope", () => {
  expect(DEFAULT_OPENVIKING_TRANSPORT_LIMITS).toEqual({
    maxRequestBytes: 1_048_576,
    maxResponseBytes: 8_388_608,
    timeoutMs: 15_000,
  });
  expect(decideTransportSize({ kind: "request", bytes: 1_048_576 })).toEqual({ ok: true });
  expect(decideTransportSize({ kind: "request", bytes: 1_048_577 })).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("request_too_large"),
  });
  expect(decideTransportSize({ kind: "response", bytes: 8_388_608 })).toEqual({ ok: true });
  expect(decideTransportSize({ kind: "response", bytes: 8_388_609 })).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("response_too_large"),
  });
  expect(
    decideTransportSize({
      kind: "request",
      bytes: 16,
      limits: { ...DEFAULT_OPENVIKING_TRANSPORT_LIMITS, maxRequestBytes: 8 },
    }),
  ).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("request_too_large"),
  });
});

test("sanitized transport errors never echo secrets, hosts, or raw diagnostics", () => {
  const leaked =
    "connect ECONNREFUSED 10.1.2.3:1933 Authorization: Bearer ov-root-key path=/var/lib/openviking";
  for (const code of [
    "route_denied",
    "invalid_path",
    "capability_denied",
    "request_too_large",
    "response_too_large",
    "timeout",
    "runtime_unavailable",
  ] as const) {
    const failure = sanitizeOpenVikingTransportFailure(code, leaked);
    expect(JSON.stringify(failure)).not.toContain("10.1.2.3");
    expect(JSON.stringify(failure)).not.toContain("ov-root-key");
    expect(JSON.stringify(failure)).not.toContain("/var/lib/openviking");
    expect(failure.code).toBe(code);
    expect(failure.message.length).toBeGreaterThan(0);
  }
});
