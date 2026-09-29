import {
  type CoforgeMemoryActor,
  type GatewayRouteClassification,
  type GatewayRoutePolicy,
  type OpenVikingAccess,
} from "../contract";
import {
  DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  actorHasCapability,
  decideTransportSize,
  normalizeOpenVikingPath,
  sanitizeOpenVikingTransportFailure,
  type GatewayCapability,
  type RoutePolicyDecision,
} from "../route-policy";

export const MEMORY_SKILL_FAMILY_KINDS = ["skill", "session", "compile", "evolution"] as const;
export type MemorySkillFamilyKind = (typeof MEMORY_SKILL_FAMILY_KINDS)[number];
export type MemorySkillActorKind = CoforgeMemoryActor["kind"];

export type MemorySkillFamilyLimits = {
  maxRequestBytes: number;
  maxResponseBytes: number;
  timeoutMs: number;
  requestStreaming: boolean;
  responseStreaming: boolean;
};

export type MemorySkillFamilyRoute = {
  method: string;
  path: string;
  family: MemorySkillFamilyKind;
  classification: GatewayRouteClassification;
  allowedActors: readonly MemorySkillActorKind[];
  operation: "read" | "write" | "none";
  limits: MemorySkillFamilyLimits;
  note?: string;
};

const WRITERS = ["owner", "admin", "member", "agent"] as const satisfies MemorySkillActorKind[];
const SKILL_READERS = [
  "owner",
  "admin",
  "member",
  "agent",
  "memory_agent",
] as const satisfies MemorySkillActorKind[];
const SESSION_READERS = WRITERS;

const DEFAULT_LIMITS: MemorySkillFamilyLimits = {
  ...DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  requestStreaming: false,
  responseStreaming: false,
};

const SKILL_MUTATION_LIMITS: MemorySkillFamilyLimits = {
  ...DEFAULT_LIMITS,
  timeoutMs: 60_000,
};

const SESSION_MESSAGE_LIMITS: MemorySkillFamilyLimits = {
  ...DEFAULT_LIMITS,
  maxRequestBytes: 2_097_152,
};

const MEMORY_EXTRACT_LIMITS: MemorySkillFamilyLimits = {
  ...DEFAULT_LIMITS,
  timeoutMs: 60_000,
};

function dataPlane(input: {
  method: string;
  path: string;
  family: MemorySkillFamilyKind;
  operation: "read" | "write";
  allowedActors: readonly MemorySkillActorKind[];
  limits?: MemorySkillFamilyLimits;
}): MemorySkillFamilyRoute {
  return {
    method: input.method,
    path: input.path,
    family: input.family,
    classification: "data-plane",
    allowedActors: input.allowedActors,
    operation: input.operation,
    limits: input.limits ?? DEFAULT_LIMITS,
  };
}

function typedControl(input: {
  method: string;
  path: string;
  family: MemorySkillFamilyKind;
  limits?: MemorySkillFamilyLimits;
  note: string;
}): MemorySkillFamilyRoute {
  return {
    method: input.method,
    path: input.path,
    family: input.family,
    classification: "typed-control-only",
    allowedActors: [],
    operation: "none",
    limits: input.limits ?? DEFAULT_LIMITS,
    note: input.note,
  };
}

const COMMIT_EXTRACT_NOTE =
  "typed-control-only: native session memory extract stays off the generic gateway; F1 admission uses a typed channel; Fact Index must not invoke";

/** G3.2 family manifest. G3.5 aggregates this; G2 tracer catalog stays unchanged. */
export const MEMORY_SKILL_FAMILY_ROUTES: readonly MemorySkillFamilyRoute[] = [
  dataPlane({
    method: "GET",
    path: "/api/v1/skills",
    family: "skill",
    operation: "read",
    allowedActors: SKILL_READERS,
  }),
  dataPlane({
    method: "POST",
    path: "/api/v1/skills",
    family: "skill",
    operation: "write",
    allowedActors: WRITERS,
    limits: SKILL_MUTATION_LIMITS,
  }),
  dataPlane({
    method: "POST",
    path: "/api/v1/skills/find",
    family: "skill",
    operation: "read",
    allowedActors: SKILL_READERS,
  }),
  dataPlane({
    method: "POST",
    path: "/api/v1/skills/validate",
    family: "skill",
    operation: "write",
    allowedActors: WRITERS,
  }),
  dataPlane({
    method: "GET",
    path: "/api/v1/skills/{skill_name}",
    family: "skill",
    operation: "read",
    allowedActors: SKILL_READERS,
  }),
  dataPlane({
    method: "PUT",
    path: "/api/v1/skills/{skill_name}",
    family: "skill",
    operation: "write",
    allowedActors: WRITERS,
    limits: SKILL_MUTATION_LIMITS,
  }),
  dataPlane({
    method: "DELETE",
    path: "/api/v1/skills/{skill_name}",
    family: "skill",
    operation: "write",
    allowedActors: WRITERS,
  }),
  dataPlane({
    method: "POST",
    path: "/api/v1/sessions",
    family: "session",
    operation: "write",
    allowedActors: WRITERS,
  }),
  dataPlane({
    method: "GET",
    path: "/api/v1/sessions",
    family: "session",
    operation: "read",
    allowedActors: SESSION_READERS,
  }),
  dataPlane({
    method: "GET",
    path: "/api/v1/sessions/{session_id}",
    family: "session",
    operation: "read",
    allowedActors: SESSION_READERS,
  }),
  dataPlane({
    method: "PATCH",
    path: "/api/v1/sessions/{session_id}/config",
    family: "session",
    operation: "write",
    allowedActors: WRITERS,
  }),
  dataPlane({
    method: "GET",
    path: "/api/v1/sessions/{session_id}/tool-results",
    family: "session",
    operation: "read",
    allowedActors: SESSION_READERS,
  }),
  dataPlane({
    method: "GET",
    path: "/api/v1/sessions/{session_id}/tool-results/{tool_result_id}",
    family: "session",
    operation: "read",
    allowedActors: SESSION_READERS,
  }),
  dataPlane({
    method: "GET",
    path: "/api/v1/sessions/{session_id}/tool-results/{tool_result_id}/search",
    family: "session",
    operation: "read",
    allowedActors: SESSION_READERS,
  }),
  dataPlane({
    method: "GET",
    path: "/api/v1/sessions/{session_id}/context",
    family: "session",
    operation: "read",
    allowedActors: SESSION_READERS,
  }),
  dataPlane({
    method: "GET",
    path: "/api/v1/sessions/{session_id}/archives/{archive_id}",
    family: "session",
    operation: "read",
    allowedActors: SESSION_READERS,
  }),
  dataPlane({
    method: "DELETE",
    path: "/api/v1/sessions/{session_id}",
    family: "session",
    operation: "write",
    allowedActors: WRITERS,
  }),
  typedControl({
    method: "POST",
    path: "/api/v1/sessions/{session_id}/commit",
    family: "session",
    limits: MEMORY_EXTRACT_LIMITS,
    note: COMMIT_EXTRACT_NOTE,
  }),
  typedControl({
    method: "POST",
    path: "/api/v1/sessions/{session_id}/extract",
    family: "session",
    limits: MEMORY_EXTRACT_LIMITS,
    note: COMMIT_EXTRACT_NOTE,
  }),
  dataPlane({
    method: "POST",
    path: "/api/v1/sessions/{session_id}/messages",
    family: "session",
    operation: "write",
    allowedActors: WRITERS,
    limits: SESSION_MESSAGE_LIMITS,
  }),
  dataPlane({
    method: "POST",
    path: "/api/v1/sessions/{session_id}/messages/batch",
    family: "session",
    operation: "write",
    allowedActors: WRITERS,
    limits: SESSION_MESSAGE_LIMITS,
  }),
  dataPlane({
    method: "POST",
    path: "/api/v1/sessions/{session_id}/used",
    family: "session",
    operation: "write",
    allowedActors: WRITERS,
  }),
  dataPlane({
    method: "GET",
    path: "/api/v1/agent-evolution/experiences/trajectories",
    family: "evolution",
    operation: "read",
    allowedActors: SESSION_READERS,
  }),
  dataPlane({
    method: "GET",
    path: "/api/v1/agent-evolution/experiences/outcomes",
    family: "evolution",
    operation: "read",
    allowedActors: SESSION_READERS,
  }),
  dataPlane({
    method: "POST",
    path: "/api/v1/compile",
    family: "compile",
    operation: "write",
    allowedActors: WRITERS,
  }),
  dataPlane({
    method: "GET",
    path: "/api/v1/compile/capabilities",
    family: "compile",
    operation: "read",
    allowedActors: SESSION_READERS,
  }),
  dataPlane({
    method: "GET",
    path: "/api/v1/compile/submissions/{key}",
    family: "compile",
    operation: "read",
    allowedActors: SESSION_READERS,
  }),
];

export function toMemorySkillFamilyPolicies(
  routes: readonly MemorySkillFamilyRoute[] = MEMORY_SKILL_FAMILY_ROUTES,
): readonly GatewayRoutePolicy[] {
  return routes.map((route) => ({
    method: route.method,
    path: route.path,
    classification: route.classification,
  }));
}

function templateMatches(template: string, path: string): boolean {
  const templateSegments = template.split("/");
  const pathSegments = path.split("/");
  if (templateSegments.length !== pathSegments.length) return false;
  return templateSegments.every((segment, index) => {
    const value = pathSegments[index];
    return (segment.startsWith("{") && segment.endsWith("}")) || segment === value;
  });
}

export function lookupMemorySkillFamilyRoute(
  method: string,
  path: string,
): MemorySkillFamilyRoute | null {
  const normalized = normalizeOpenVikingPath(path);
  const candidate = normalized.ok ? normalized.path : path;
  const upper = method.toUpperCase();
  return (
    MEMORY_SKILL_FAMILY_ROUTES.find((route) => {
      if (route.method.toUpperCase() !== upper) return false;
      return route.path === candidate || templateMatches(route.path, candidate);
    }) ?? null
  );
}

export function accessForCoforgeActor(kind: MemorySkillActorKind): OpenVikingAccess {
  switch (kind) {
    case "owner":
    case "admin":
      return "workspace_admin";
    case "member":
      return "own_namespace";
    case "agent":
      return "explicit_grant";
    case "memory_agent":
      return "readonly_shared";
    case "projection_worker":
      return "projection_only";
  }
}

export function requiredCapabilityForMemorySkillActor(
  route: MemorySkillFamilyRoute,
  actorKind: MemorySkillActorKind,
): GatewayCapability | null {
  if (route.classification !== "data-plane" || !route.allowedActors.includes(actorKind)) {
    return null;
  }
  if (route.operation === "read") return "read_shared";
  if (route.operation === "write") {
    return actorKind === "agent" ? "write_granted" : "write_own_namespace";
  }
  return null;
}

export function decideMemorySkillFamilyAccess(input: {
  actor: CoforgeMemoryActor;
  method: string;
  path: string;
  requestBytes?: number;
}): RoutePolicyDecision {
  const normalized = normalizeOpenVikingPath(input.path);
  if (!normalized.ok) return normalized;
  const method = input.method.toUpperCase();
  const route = lookupMemorySkillFamilyRoute(method, normalized.path);
  if (!route || route.classification !== "data-plane") {
    return { ok: false, failure: sanitizeOpenVikingTransportFailure("route_denied") };
  }
  if (!route.allowedActors.includes(input.actor.kind)) {
    return { ok: false, failure: sanitizeOpenVikingTransportFailure("capability_denied") };
  }
  const requiredCapability = requiredCapabilityForMemorySkillActor(route, input.actor.kind);
  const access = accessForCoforgeActor(input.actor.kind);
  if (!requiredCapability || !actorHasCapability(access, requiredCapability)) {
    return { ok: false, failure: sanitizeOpenVikingTransportFailure("capability_denied") };
  }
  if (input.requestBytes !== undefined) {
    const size = decideTransportSize({
      kind: "request",
      bytes: input.requestBytes,
      limits: route.limits,
    });
    if (!size.ok) return size;
  }
  return { ok: true, method, path: normalized.path, classification: "data-plane" };
}
