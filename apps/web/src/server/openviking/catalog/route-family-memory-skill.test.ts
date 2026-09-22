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
  MEMORY_SKILL_FAMILY_KINDS,
  MEMORY_SKILL_FAMILY_ROUTES,
  accessForCoforgeActor,
  decideMemorySkillFamilyAccess,
  lookupMemorySkillFamilyRoute,
  requiredCapabilityForMemorySkillActor,
  toMemorySkillFamilyPolicies,
  type MemorySkillActorKind,
  type MemorySkillFamilyKind,
} from "./route-family-memory-skill";

const FAMILY_KINDS = new Set<MemorySkillFamilyKind>(["skill", "session", "compile", "evolution"]);

const ALL_ACTORS: readonly CoforgeMemoryActor[] = [
  { kind: "owner", userId: "u-owner" },
  { kind: "admin", userId: "u-admin" },
  { kind: "member", userId: "u-member" },
  { kind: "agent", agentId: "ag-1" },
  { kind: "memory_agent", agentId: "mem-1" },
  { kind: "projection_worker" },
];

const WRITERS: readonly MemorySkillActorKind[] = ["owner", "admin", "member", "agent"];
const SKILL_READERS: readonly MemorySkillActorKind[] = [
  "owner",
  "admin",
  "member",
  "agent",
  "memory_agent",
];
const SESSION_READERS: readonly MemorySkillActorKind[] = WRITERS;

type ExpectedRoute = {
  method: string;
  path: string;
  family: MemorySkillFamilyKind;
  classification: GatewayRouteClassification;
  allowedActors: readonly MemorySkillActorKind[];
};

/** Independent G3.2 spec: D3 §6.3 plus Memory Agent read-only and typed extract rules. */
const EXPECTED_ROUTES: readonly ExpectedRoute[] = [
  {
    method: "GET",
    path: "/api/v1/skills",
    family: "skill",
    classification: "data-plane",
    allowedActors: SKILL_READERS,
  },
  {
    method: "POST",
    path: "/api/v1/skills",
    family: "skill",
    classification: "data-plane",
    allowedActors: WRITERS,
  },
  {
    method: "POST",
    path: "/api/v1/skills/find",
    family: "skill",
    classification: "data-plane",
    allowedActors: SKILL_READERS,
  },
  {
    method: "POST",
    path: "/api/v1/skills/validate",
    family: "skill",
    classification: "data-plane",
    allowedActors: WRITERS,
  },
  {
    method: "GET",
    path: "/api/v1/skills/{skill_name}",
    family: "skill",
    classification: "data-plane",
    allowedActors: SKILL_READERS,
  },
  {
    method: "PUT",
    path: "/api/v1/skills/{skill_name}",
    family: "skill",
    classification: "data-plane",
    allowedActors: WRITERS,
  },
  {
    method: "DELETE",
    path: "/api/v1/skills/{skill_name}",
    family: "skill",
    classification: "data-plane",
    allowedActors: WRITERS,
  },
  {
    method: "POST",
    path: "/api/v1/sessions",
    family: "session",
    classification: "data-plane",
    allowedActors: WRITERS,
  },
  {
    method: "GET",
    path: "/api/v1/sessions",
    family: "session",
    classification: "data-plane",
    allowedActors: SESSION_READERS,
  },
  {
    method: "GET",
    path: "/api/v1/sessions/{session_id}",
    family: "session",
    classification: "data-plane",
    allowedActors: SESSION_READERS,
  },
  {
    method: "PATCH",
    path: "/api/v1/sessions/{session_id}/config",
    family: "session",
    classification: "data-plane",
    allowedActors: WRITERS,
  },
  {
    method: "GET",
    path: "/api/v1/sessions/{session_id}/tool-results",
    family: "session",
    classification: "data-plane",
    allowedActors: SESSION_READERS,
  },
  {
    method: "GET",
    path: "/api/v1/sessions/{session_id}/tool-results/{tool_result_id}",
    family: "session",
    classification: "data-plane",
    allowedActors: SESSION_READERS,
  },
  {
    method: "GET",
    path: "/api/v1/sessions/{session_id}/tool-results/{tool_result_id}/search",
    family: "session",
    classification: "data-plane",
    allowedActors: SESSION_READERS,
  },
  {
    method: "GET",
    path: "/api/v1/sessions/{session_id}/context",
    family: "session",
    classification: "data-plane",
    allowedActors: SESSION_READERS,
  },
  {
    method: "GET",
    path: "/api/v1/sessions/{session_id}/archives/{archive_id}",
    family: "session",
    classification: "data-plane",
    allowedActors: SESSION_READERS,
  },
  {
    method: "DELETE",
    path: "/api/v1/sessions/{session_id}",
    family: "session",
    classification: "data-plane",
    allowedActors: WRITERS,
  },
  {
    method: "POST",
    path: "/api/v1/sessions/{session_id}/commit",
    family: "session",
    classification: "typed-control-only",
    allowedActors: [],
  },
  {
    method: "POST",
    path: "/api/v1/sessions/{session_id}/extract",
    family: "session",
    classification: "typed-control-only",
    allowedActors: [],
  },
  {
    method: "POST",
    path: "/api/v1/sessions/{session_id}/messages",
    family: "session",
    classification: "data-plane",
    allowedActors: WRITERS,
  },
  {
    method: "POST",
    path: "/api/v1/sessions/{session_id}/messages/batch",
    family: "session",
    classification: "data-plane",
    allowedActors: WRITERS,
  },
  {
    method: "POST",
    path: "/api/v1/sessions/{session_id}/used",
    family: "session",
    classification: "data-plane",
    allowedActors: WRITERS,
  },
  {
    method: "GET",
    path: "/api/v1/agent-evolution/experiences/trajectories",
    family: "evolution",
    classification: "data-plane",
    allowedActors: SESSION_READERS,
  },
  {
    method: "GET",
    path: "/api/v1/agent-evolution/experiences/outcomes",
    family: "evolution",
    classification: "data-plane",
    allowedActors: SESSION_READERS,
  },
  {
    method: "POST",
    path: "/api/v1/compile",
    family: "compile",
    classification: "data-plane",
    allowedActors: WRITERS,
  },
  {
    method: "GET",
    path: "/api/v1/compile/capabilities",
    family: "compile",
    classification: "data-plane",
    allowedActors: SESSION_READERS,
  },
  {
    method: "GET",
    path: "/api/v1/compile/submissions/{key}",
    family: "compile",
    classification: "data-plane",
    allowedActors: SESSION_READERS,
  },
];

const MEMORY_AGENT_ALLOWED_PATHS = new Set([
  "GET /api/v1/skills",
  "POST /api/v1/skills/find",
  "GET /api/v1/skills/{skill_name}",
]);

function samplePath(template: string): string {
  return template
    .replaceAll("{skill_name}", "web-search")
    .replaceAll("{session_id}", "sess-1")
    .replaceAll("{tool_result_id}", "tr-1")
    .replaceAll("{archive_id}", "arch-1")
    .replaceAll("{key}", "studio-compile-001");
}

function actorByKind(kind: MemorySkillActorKind): CoforgeMemoryActor {
  const actor = ALL_ACTORS.find((entry) => entry.kind === kind);
  if (!actor) throw new Error(`missing actor ${kind}`);
  return actor;
}

function routeKey(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

test("manifest covers every pinned skill/session/compile/evolution route once", () => {
  const pinned = PINNED_OPENVIKING_ROUTES.filter((route) =>
    FAMILY_KINDS.has(route.family as MemorySkillFamilyKind),
  );
  expect(MEMORY_SKILL_FAMILY_KINDS).toEqual(["skill", "session", "compile", "evolution"]);
  expect(pinned.map(routeKey).sort()).toEqual(EXPECTED_ROUTES.map(routeKey).sort());
  expect(MEMORY_SKILL_FAMILY_ROUTES.map(routeKey).sort()).toEqual(
    EXPECTED_ROUTES.map(routeKey).sort(),
  );
  expect(new Set(MEMORY_SKILL_FAMILY_ROUTES.map(routeKey)).size).toBe(EXPECTED_ROUTES.length);
});

test("each family route matches the independent classification spec", () => {
  for (const expected of EXPECTED_ROUTES) {
    const actual = MEMORY_SKILL_FAMILY_ROUTES.find(
      (route) => route.method === expected.method && route.path === expected.path,
    );
    expect(actual, routeKey(expected)).toBeDefined();
    if (!actual) continue;
    expect(actual.family).toBe(expected.family);
    expect(actual.classification).toBe(expected.classification);
    expect([...actual.allowedActors]).toEqual([...expected.allowedActors]);
    expect(actual.limits.requestStreaming).toBe(false);
    expect(actual.limits.responseStreaming).toBe(false);
    if (expected.classification !== "data-plane") {
      expect(actual.allowedActors).toEqual([]);
      expect(actual.note).toMatch(/typed/i);
    }
  }
});

test("each family route has a positive allow or typed-control disposition and a negative denial", () => {
  for (const expected of EXPECTED_ROUTES) {
    const path = samplePath(expected.path);
    if (expected.classification === "data-plane") {
      expect(expected.allowedActors.length).toBeGreaterThan(0);
      for (const kind of expected.allowedActors) {
        const decision = decideMemorySkillFamilyAccess({
          actor: actorByKind(kind),
          method: expected.method,
          path,
        });
        expect(decision, `${routeKey(expected)} ${kind}`).toEqual({
          ok: true,
          method: expected.method,
          path,
          classification: "data-plane",
        });
      }
      for (const actor of ALL_ACTORS.filter(
        (entry) => !expected.allowedActors.includes(entry.kind),
      )) {
        const decision = decideMemorySkillFamilyAccess({
          actor,
          method: expected.method,
          path,
        });
        expect(decision.ok, `${routeKey(expected)} ${actor.kind}`).toBe(false);
        if (!decision.ok) expect(decision.failure.code).toBe("capability_denied");
      }
      continue;
    }

    expect(lookupMemorySkillFamilyRoute(expected.method, path)?.classification).toBe(
      expected.classification,
    );
    for (const actor of ALL_ACTORS) {
      const decision = decideMemorySkillFamilyAccess({
        actor,
        method: expected.method,
        path,
      });
      expect(decision).toEqual({
        ok: false,
        failure: sanitizeOpenVikingTransportFailure("route_denied"),
      });
    }
  }
});

test("Memory Agent capability matrix allows only explicit skill reads", () => {
  const memoryAgent: CoforgeMemoryActor = { kind: "memory_agent", agentId: "mem-1" };
  const allowed: string[] = [];
  const denied: string[] = [];

  for (const expected of EXPECTED_ROUTES) {
    const decision = decideMemorySkillFamilyAccess({
      actor: memoryAgent,
      method: expected.method,
      path: samplePath(expected.path),
    });
    if (decision.ok) {
      allowed.push(routeKey(expected));
      expect(expected.classification).toBe("data-plane");
      expect(MEMORY_AGENT_ALLOWED_PATHS.has(routeKey(expected))).toBe(true);
    } else {
      denied.push(routeKey(expected));
      expect(MEMORY_AGENT_ALLOWED_PATHS.has(routeKey(expected))).toBe(false);
      expect(["route_denied", "capability_denied"]).toContain(decision.failure.code);
    }
  }

  expect(allowed.sort()).toEqual([...MEMORY_AGENT_ALLOWED_PATHS].sort());
  expect(denied).toHaveLength(EXPECTED_ROUTES.length - MEMORY_AGENT_ALLOWED_PATHS.size);
  expect(
    decideMemorySkillFamilyAccess({
      actor: memoryAgent,
      method: "POST",
      path: "/api/v1/sessions/sess-1/commit",
    }),
  ).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("route_denied"),
  });
  expect(
    decideMemorySkillFamilyAccess({
      actor: memoryAgent,
      method: "PUT",
      path: "/api/v1/skills/web-search",
    }),
  ).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("capability_denied"),
  });
});

test("unknown paths and methods stay denied even for workspace admins", () => {
  const owner: CoforgeMemoryActor = { kind: "owner", userId: "u-owner" };
  for (const route of [
    { method: "GET", path: "/api/v1/memory" },
    { method: "POST", path: "/api/v1/memory/extract" },
    { method: "GET", path: "/api/v1/skills/web-search/versions" },
    { method: "DELETE", path: "/api/v1/skills" },
    { method: "POST", path: "/api/v1/sessions/sess-1/commit/force" },
    { method: "GET", path: "/api/v1/admin/agent-evolution" },
  ]) {
    expect(
      decideMemorySkillFamilyAccess({
        actor: owner,
        method: route.method,
        path: route.path,
      }),
    ).toEqual({
      ok: false,
      failure: sanitizeOpenVikingTransportFailure("route_denied"),
    });
    expect(lookupMemorySkillFamilyRoute(route.method, route.path)).toBeNull();
  }
});

test("C1 actor access and write/read capabilities stay aligned with the gateway policy shape", () => {
  const binding = { accountId: "acct-ws-a", serviceIdentityId: "svc-projection-ws-a" };
  for (const actor of ALL_ACTORS) {
    expect(accessForCoforgeActor(actor.kind)).toBe(mapMemoryActor({ actor, binding }).access);
  }

  const skillWrite = lookupMemorySkillFamilyRoute("POST", "/api/v1/skills");
  const skillRead = lookupMemorySkillFamilyRoute("GET", "/api/v1/skills");
  expect(skillWrite).not.toBeNull();
  expect(skillRead).not.toBeNull();
  if (!skillWrite || !skillRead) return;

  expect(requiredCapabilityForMemorySkillActor(skillRead, "memory_agent")).toBe("read_shared");
  expect(requiredCapabilityForMemorySkillActor(skillWrite, "member")).toBe("write_own_namespace");
  expect(requiredCapabilityForMemorySkillActor(skillWrite, "agent")).toBe("write_granted");
  expect(requiredCapabilityForMemorySkillActor(skillWrite, "memory_agent")).toBeNull();

  const catalog = toMemorySkillFamilyPolicies();
  expect(
    decideRoutePolicy({
      method: "GET",
      path: "/api/v1/skills",
      access: "readonly_shared",
      requiredCapability: "read_shared",
      catalog,
    }),
  ).toEqual({
    ok: true,
    method: "GET",
    path: "/api/v1/skills",
    classification: "data-plane",
  });
  expect(
    decideRoutePolicy({
      method: "POST",
      path: "/api/v1/sessions/sess-1/commit",
      access: "workspace_admin",
      requiredCapability: "write_own_namespace",
      catalog,
    }),
  ).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("route_denied"),
  });
});

test("family body and stream limits fail closed and keep extract off the generic plane", () => {
  const owner: CoforgeMemoryActor = { kind: "owner", userId: "u-owner" };
  const batch = lookupMemorySkillFamilyRoute("POST", "/api/v1/sessions/sess-1/messages/batch");
  const extract = lookupMemorySkillFamilyRoute("POST", "/api/v1/sessions/sess-1/extract");
  const skillPut = lookupMemorySkillFamilyRoute("PUT", "/api/v1/skills/web-search");
  expect(batch?.limits.maxRequestBytes).toBe(2_097_152);
  expect(extract?.limits.timeoutMs).toBe(60_000);
  expect(skillPut?.limits.timeoutMs).toBe(60_000);
  expect(extract?.classification).toBe("typed-control-only");

  expect(
    decideMemorySkillFamilyAccess({
      actor: owner,
      method: "POST",
      path: "/api/v1/sessions/sess-1/messages/batch",
      requestBytes: 2_097_152,
    }).ok,
  ).toBe(true);
  expect(
    decideMemorySkillFamilyAccess({
      actor: owner,
      method: "POST",
      path: "/api/v1/sessions/sess-1/messages/batch",
      requestBytes: 2_097_153,
    }),
  ).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("request_too_large"),
  });
  expect(
    decideMemorySkillFamilyAccess({
      actor: owner,
      method: "GET",
      path: "/api/v1/skills",
      requestBytes: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxRequestBytes + 1,
    }),
  ).toEqual({
    ok: false,
    failure: sanitizeOpenVikingTransportFailure("request_too_large"),
  });
});
