import { expect, test } from "bun:test";
import type { CoforgeMemoryActor } from "../contract";
import { PINNED_OPENVIKING_ROUTES } from "../route-catalog";
import {
  DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  decideTransportSize,
  sanitizeOpenVikingTransportFailure,
} from "../route-policy";
import {
  CONTENT_FAMILY_GATEWAY_CATALOG,
  CONTENT_FAMILY_NAMES,
  CONTENT_FAMILY_ROUTES,
  decideContentFamilyRoute,
  type ContentFamilyActorKind,
  type GatewayRouteClassification,
} from "./route-family-content";

const ACTOR_KINDS = [
  "owner",
  "admin",
  "member",
  "agent",
  "memory_agent",
  "projection_worker",
] as const satisfies readonly ContentFamilyActorKind[];

function actorFor(kind: ContentFamilyActorKind): CoforgeMemoryActor {
  switch (kind) {
    case "owner":
      return { kind, userId: "u-1" };
    case "admin":
      return { kind, userId: "u-2" };
    case "member":
      return { kind, userId: "u-3" };
    case "agent":
      return { kind, agentId: "ag-1" };
    case "memory_agent":
      return { kind, agentId: "mem-1" };
    case "projection_worker":
      return { kind };
  }
}

function keyOf(method: string, path: string): string {
  return `${method} ${path}`;
}

const OPS_OWNED_CONTENT_KEYS = new Set(["POST /api/v1/content/reindex"]);

const PINNED_CONTENT_FAMILY_ROUTES = PINNED_OPENVIKING_ROUTES.filter(
  (route) =>
    (CONTENT_FAMILY_NAMES as readonly string[]).includes(route.family) &&
    !OPS_OWNED_CONTENT_KEYS.has(keyOf(route.method, route.path)),
);

/** Independent spec: D3 pinned resources/filesystem/content/search dispositions. */
const EXPECTED_CLASSIFICATION: Record<string, GatewayRouteClassification> = {
  "POST /api/v1/resources/temp_upload": "data-plane",
  "POST /api/v1/resources": "data-plane",
  "GET /api/v1/fs/ls": "data-plane",
  "GET /api/v1/fs/tree": "data-plane",
  "GET /api/v1/fs/stat": "data-plane",
  "GET /api/v1/fs/attrs": "data-plane",
  "POST /api/v1/fs/attrs/set_tags": "data-plane",
  "POST /api/v1/fs/mkdir": "data-plane",
  "DELETE /api/v1/fs": "data-plane",
  "POST /api/v1/fs/cp": "data-plane",
  "POST /api/v1/fs/mv": "data-plane",
  "GET /api/v1/content/read": "data-plane",
  "GET /api/v1/content/abstract": "data-plane",
  "GET /api/v1/content/overview": "data-plane",
  "GET /api/v1/content/download": "data-plane",
  "POST /api/v1/content/write": "data-plane",
  "POST /api/v1/content/batch-write": "data-plane",
  "POST /api/v1/content/set_tags": "data-plane",
  "POST /api/v1/search/find": "data-plane",
  "POST /api/v1/search/search": "data-plane",
  "POST /api/v1/search/recall": "denied",
  "POST /api/v1/search/grep": "data-plane",
  "POST /api/v1/search/glob": "data-plane",
};

const MEMORY_AGENT_READS = new Set([
  "POST /api/v1/search/find",
  "POST /api/v1/search/search",
  "GET /api/v1/content/read",
  "GET /api/v1/content/abstract",
  "GET /api/v1/content/overview",
]);

const PROJECTION_WRITES = new Set([
  "POST /api/v1/content/write",
  "POST /api/v1/content/batch-write",
  "POST /api/v1/content/set_tags",
  "POST /api/v1/fs/attrs/set_tags",
  "POST /api/v1/fs/mkdir",
  "DELETE /api/v1/fs",
]);

const WORKSPACE_WRITERS = new Set<ContentFamilyActorKind>(["owner", "admin", "member", "agent"]);

function expectAllowed(kind: ContentFamilyActorKind, method: string, path: string): boolean {
  const classification = EXPECTED_CLASSIFICATION[keyOf(method, path)];
  if (classification !== "data-plane") return false;
  if (kind === "memory_agent") return MEMORY_AGENT_READS.has(keyOf(method, path));
  if (kind === "projection_worker") return PROJECTION_WRITES.has(keyOf(method, path));
  return WORKSPACE_WRITERS.has(kind);
}

test("every pinned resources/filesystem/content/search route is classified exactly once", () => {
  expect(PINNED_CONTENT_FAMILY_ROUTES).toHaveLength(23);
  expect(CONTENT_FAMILY_ROUTES).toHaveLength(23);
  expect(Object.keys(EXPECTED_CLASSIFICATION)).toHaveLength(23);

  const seen = new Set<string>();
  for (const route of CONTENT_FAMILY_ROUTES) {
    const key = keyOf(route.method, route.path);
    expect(seen.has(key)).toBe(false);
    seen.add(key);
    expect(EXPECTED_CLASSIFICATION[key]).toBe(route.classification);
    expect(
      CONTENT_FAMILY_GATEWAY_CATALOG.filter((entry) => keyOf(entry.method, entry.path) === key),
    ).toHaveLength(1);
  }

  for (const pinned of PINNED_CONTENT_FAMILY_ROUTES) {
    expect(seen.has(keyOf(pinned.method, pinned.path))).toBe(true);
  }
});

test("each content-family route has a positive decision for allowed actors and a negative for others", () => {
  for (const route of CONTENT_FAMILY_ROUTES) {
    for (const kind of ACTOR_KINDS) {
      const decision = decideContentFamilyRoute({
        method: route.method,
        path: route.path,
        actor: actorFor(kind),
      });
      const allowed = expectAllowed(kind, route.method, route.path);
      if (allowed) {
        expect(decision).toEqual({
          ok: true,
          method: route.method,
          path: route.path,
          classification: "data-plane",
        });
      } else if (route.classification !== "data-plane") {
        expect(decision).toEqual({
          ok: false,
          failure: sanitizeOpenVikingTransportFailure("route_denied"),
        });
      } else {
        expect(decision).toEqual({
          ok: false,
          failure: sanitizeOpenVikingTransportFailure("capability_denied"),
        });
      }
    }
  }
});

test("Memory Agent may only use the approved read routes in this family", () => {
  const matrix = CONTENT_FAMILY_ROUTES.map((route) => {
    const decision = decideContentFamilyRoute({
      method: route.method,
      path: route.path,
      actor: actorFor("memory_agent"),
    });
    return {
      route: keyOf(route.method, route.path),
      allowed: decision.ok,
      failure: decision.ok ? undefined : decision.failure.code,
    };
  });

  expect(matrix.filter((row) => row.allowed).map((row) => row.route)).toEqual([
    "GET /api/v1/content/read",
    "GET /api/v1/content/abstract",
    "GET /api/v1/content/overview",
    "POST /api/v1/search/find",
    "POST /api/v1/search/search",
  ]);

  for (const row of matrix) {
    if (MEMORY_AGENT_READS.has(row.route)) {
      expect(row.allowed).toBe(true);
      continue;
    }
    expect(row.allowed).toBe(false);
    expect(row.failure).toBe(
      EXPECTED_CLASSIFICATION[row.route] === "data-plane" ? "capability_denied" : "route_denied",
    );
  }

  expect(
    decideContentFamilyRoute({
      method: "POST",
      path: "/api/v1/content/write",
      actor: actorFor("memory_agent"),
    }),
  ).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("capability_denied"),
  });
  expect(
    decideContentFamilyRoute({
      method: "POST",
      path: "/api/v1/resources",
      actor: actorFor("memory_agent"),
    }),
  ).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("capability_denied"),
  });
});

test("unknown paths and methods stay denied even for Workspace Owner", () => {
  const owner = actorFor("owner");
  for (const route of [
    { method: "POST", path: "/api/v1/content/invented" },
    { method: "GET", path: "/api/v1/search/unknown" },
    { method: "GET", path: "/api/v1/search/find" },
    { method: "POST", path: "/api/v1/sessions" },
    { method: "GET", path: "/health" },
    { method: "DELETE", path: "/api/v1/admin/accounts/acct-ws-a" },
    { method: "GET", path: "/api/v1/fs/../admin/accounts" },
  ]) {
    const decision = decideContentFamilyRoute({
      method: route.method,
      path: route.path,
      actor: owner,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(["route_denied", "invalid_path"]).toContain(decision.failure.code);
    }
  }
});

test("deprecated recall never enters the generic data plane; reindex is owned by ops", () => {
  expect(
    CONTENT_FAMILY_ROUTES.some(
      (route) => route.method === "POST" && route.path === "/api/v1/content/reindex",
    ),
  ).toBe(false);
  const recall = CONTENT_FAMILY_ROUTES.find(
    (route) => route.method === "POST" && route.path === "/api/v1/search/recall",
  );
  expect(recall?.classification).toBe("denied");
  expect(recall?.allowedActors).toEqual([]);
  expect(recall?.controlNote).toMatch(/deprecated/i);

  for (const kind of ACTOR_KINDS) {
    expect(
      decideContentFamilyRoute({
        method: "POST",
        path: "/api/v1/content/reindex",
        actor: actorFor(kind),
      }),
    ).toEqual({
      ok: false,
      failure: sanitizeOpenVikingTransportFailure("route_denied"),
    });
    expect(
      decideContentFamilyRoute({
        method: "POST",
        path: "/api/v1/search/recall",
        actor: actorFor(kind),
      }),
    ).toEqual({
      ok: false,
      failure: sanitizeOpenVikingTransportFailure("route_denied"),
    });
  }
});

test("body and stream envelopes follow the family limits and official write caps", () => {
  const byKey = new Map(
    CONTENT_FAMILY_ROUTES.map((route) => [keyOf(route.method, route.path), route]),
  );

  expect(byKey.get("POST /api/v1/resources/temp_upload")).toMatchObject({
    requestBody: "multipart",
    stream: { request: true, response: false },
    limits: {
      maxRequestBytes: 16_777_216,
      maxResponseBytes: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxResponseBytes,
      timeoutMs: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.timeoutMs,
    },
  });
  expect(byKey.get("POST /api/v1/content/batch-write")?.limits.maxRequestBytes).toBe(16_777_216);
  expect(byKey.get("POST /api/v1/content/write")?.limits.maxRequestBytes).toBe(8_388_608);
  expect(byKey.get("GET /api/v1/content/download")).toMatchObject({
    requestBody: "none",
    stream: { request: false, response: true },
    limits: DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  });
  expect(byKey.get("POST /api/v1/search/find")?.limits).toEqual(
    DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  );
  expect(byKey.get("GET /api/v1/fs/ls")).toMatchObject({
    requestBody: "none",
    stream: { request: false, response: false },
  });

  expect(
    decideTransportSize({
      kind: "request",
      bytes: 16_777_216,
      limits: byKey.get("POST /api/v1/resources/temp_upload")?.limits,
    }),
  ).toEqual({ ok: true });
  expect(
    decideTransportSize({
      kind: "request",
      bytes: 16_777_217,
      limits: byKey.get("POST /api/v1/resources/temp_upload")?.limits,
    }),
  ).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("request_too_large"),
  });
});

test("the content-family manifest stays a pure policy table", async () => {
  const text = await Bun.file(`${import.meta.dir}/route-family-content.ts`).text();
  expect(text).not.toMatch(/@prisma/);
  expect(text).not.toMatch(/@tanstack/);
  expect(text).not.toMatch(/from ["']prisma/);
  expect(text).not.toMatch(/\bfetch\s*\(/);
  expect(text).not.toMatch(/policy-gateway/);
});
