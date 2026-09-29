import {
  mapMemoryActor,
  type CoforgeMemoryActor,
  type GatewayRouteClassification,
  type GatewayRoutePolicy,
  type OpenVikingAccess,
} from "../contract";
import {
  DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
  classifyOpenVikingRoute,
  decideRoutePolicy,
  normalizeOpenVikingPath,
  sanitizeOpenVikingTransportFailure,
  type GatewayCapability,
  type OpenVikingTransportLimits,
  type RoutePolicyDecision,
} from "../route-policy";

export type { GatewayRouteClassification };

export const CONTENT_FAMILY_NAMES = ["resources", "filesystem", "content", "search"] as const;
export type ContentFamilyName = (typeof CONTENT_FAMILY_NAMES)[number];

export type ContentFamilyActorKind = CoforgeMemoryActor["kind"];

export type ContentFamilyCapabilityRule = "read_shared" | "write_own_or_granted";

export type ContentFamilyRequestBody = "none" | "json" | "multipart";

export type ContentFamilyRoutePolicy = {
  method: string;
  path: string;
  family: ContentFamilyName;
  classification: GatewayRouteClassification;
  allowedActors: readonly ContentFamilyActorKind[];
  requiredCapability: ContentFamilyCapabilityRule;
  limits: OpenVikingTransportLimits;
  requestBody: ContentFamilyRequestBody;
  stream: { request: boolean; response: boolean };
  controlNote?: string;
};

const WORKSPACE_ACTORS = ["owner", "admin", "member", "agent"] as const;
const SHARED_READERS = [...WORKSPACE_ACTORS, "memory_agent"] as const;
const PROJECTION_WRITERS = [...WORKSPACE_ACTORS, "projection_worker"] as const;

const UPLOAD_LIMITS: OpenVikingTransportLimits = {
  maxRequestBytes: 16_777_216,
  maxResponseBytes: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxResponseBytes,
  timeoutMs: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.timeoutMs,
};

const FILE_WRITE_LIMITS: OpenVikingTransportLimits = {
  maxRequestBytes: 8_388_608,
  maxResponseBytes: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.maxResponseBytes,
  timeoutMs: DEFAULT_OPENVIKING_TRANSPORT_LIMITS.timeoutMs,
};

const DEFAULT_BINDING = { accountId: "acct-ws", serviceIdentityId: "svc-projection" };

function route(
  method: string,
  path: string,
  family: ContentFamilyName,
  classification: GatewayRouteClassification,
  extras: {
    allowedActors?: readonly ContentFamilyActorKind[];
    requiredCapability?: ContentFamilyCapabilityRule;
    limits?: OpenVikingTransportLimits;
    requestBody?: ContentFamilyRequestBody;
    stream?: { request: boolean; response: boolean };
    controlNote?: string;
  } = {},
): ContentFamilyRoutePolicy {
  const requestBody =
    extras.requestBody ??
    (method === "GET" || method === "HEAD" || method === "DELETE" ? "none" : "json");
  return {
    method,
    path,
    family,
    classification,
    allowedActors: extras.allowedActors ?? [],
    requiredCapability: extras.requiredCapability ?? "read_shared",
    limits: extras.limits ?? DEFAULT_OPENVIKING_TRANSPORT_LIMITS,
    requestBody,
    stream: extras.stream ?? { request: false, response: false },
    ...(extras.controlNote ? { controlNote: extras.controlNote } : {}),
  };
}

function writeRoute(
  method: string,
  path: string,
  family: ContentFamilyName,
  extras: {
    allowedActors?: readonly ContentFamilyActorKind[];
    limits?: OpenVikingTransportLimits;
    requestBody?: ContentFamilyRequestBody;
    stream?: { request: boolean; response: boolean };
  } = {},
): ContentFamilyRoutePolicy {
  return route(method, path, family, "data-plane", {
    allowedActors: extras.allowedActors ?? WORKSPACE_ACTORS,
    requiredCapability: "write_own_or_granted",
    limits: extras.limits,
    requestBody: extras.requestBody,
    stream: extras.stream,
  });
}

function readRoute(
  method: string,
  path: string,
  family: ContentFamilyName,
  extras: {
    allowedActors?: readonly ContentFamilyActorKind[];
    limits?: OpenVikingTransportLimits;
    stream?: { request: boolean; response: boolean };
  } = {},
): ContentFamilyRoutePolicy {
  return route(method, path, family, "data-plane", {
    allowedActors: extras.allowedActors ?? WORKSPACE_ACTORS,
    requiredCapability: "read_shared",
    limits: extras.limits,
    stream: extras.stream,
  });
}

/**
 * G3.1 resources / filesystem / content / find-search-context manifest.
 * G3.5 aggregates this table; G2's tracer catalog stays independent.
 */
export const CONTENT_FAMILY_ROUTES: readonly ContentFamilyRoutePolicy[] = [
  writeRoute("POST", "/api/v1/resources/temp_upload", "resources", {
    limits: UPLOAD_LIMITS,
    requestBody: "multipart",
    stream: { request: true, response: false },
  }),
  writeRoute("POST", "/api/v1/resources", "resources"),
  readRoute("GET", "/api/v1/fs/ls", "filesystem"),
  readRoute("GET", "/api/v1/fs/tree", "filesystem"),
  readRoute("GET", "/api/v1/fs/stat", "filesystem"),
  readRoute("GET", "/api/v1/fs/attrs", "filesystem"),
  writeRoute("POST", "/api/v1/fs/attrs/set_tags", "filesystem", {
    allowedActors: PROJECTION_WRITERS,
  }),
  writeRoute("POST", "/api/v1/fs/mkdir", "filesystem", {
    allowedActors: PROJECTION_WRITERS,
  }),
  writeRoute("DELETE", "/api/v1/fs", "filesystem", {
    allowedActors: PROJECTION_WRITERS,
  }),
  writeRoute("POST", "/api/v1/fs/cp", "filesystem"),
  writeRoute("POST", "/api/v1/fs/mv", "filesystem"),
  readRoute("GET", "/api/v1/content/read", "content", { allowedActors: SHARED_READERS }),
  readRoute("GET", "/api/v1/content/abstract", "content", { allowedActors: SHARED_READERS }),
  readRoute("GET", "/api/v1/content/overview", "content", { allowedActors: SHARED_READERS }),
  readRoute("GET", "/api/v1/content/download", "content", {
    stream: { request: false, response: true },
  }),
  writeRoute("POST", "/api/v1/content/write", "content", {
    allowedActors: PROJECTION_WRITERS,
    limits: FILE_WRITE_LIMITS,
  }),
  writeRoute("POST", "/api/v1/content/batch-write", "content", {
    allowedActors: PROJECTION_WRITERS,
    limits: UPLOAD_LIMITS,
  }),
  writeRoute("POST", "/api/v1/content/set_tags", "content", {
    allowedActors: PROJECTION_WRITERS,
  }),
  // POST /api/v1/content/reindex is owned by the G3.3 ops family.
  readRoute("POST", "/api/v1/search/find", "search", { allowedActors: SHARED_READERS }),
  readRoute("POST", "/api/v1/search/search", "search", { allowedActors: SHARED_READERS }),
  route("POST", "/api/v1/search/recall", "search", "denied", {
    controlNote:
      "Official but deprecated; defaults to query expansion and session context. Do not expose on the generic gateway.",
  }),
  readRoute("POST", "/api/v1/search/grep", "search"),
  readRoute("POST", "/api/v1/search/glob", "search"),
];

export const CONTENT_FAMILY_GATEWAY_CATALOG: readonly GatewayRoutePolicy[] =
  CONTENT_FAMILY_ROUTES.map((entry) => ({
    method: entry.method,
    path: entry.path,
    classification: entry.classification,
  }));

export function findContentFamilyRoute(
  method: string,
  path: string,
): ContentFamilyRoutePolicy | undefined {
  const normalized = normalizeOpenVikingPath(path);
  if (!normalized.ok) return undefined;
  const upper = method.toUpperCase();
  return CONTENT_FAMILY_ROUTES.find(
    (entry) => entry.method === upper && entry.path === normalized.path,
  );
}

export function contentFamilyAllowsActor(
  route: ContentFamilyRoutePolicy,
  actorKind: ContentFamilyActorKind,
): boolean {
  return route.classification === "data-plane" && route.allowedActors.includes(actorKind);
}

export function capabilityRequiredByContentFamilyRoute(
  route: ContentFamilyRoutePolicy,
  access: OpenVikingAccess,
): GatewayCapability {
  if (access === "projection_only" && route.allowedActors.includes("projection_worker")) {
    return "mutate_projection";
  }
  if (route.requiredCapability === "write_own_or_granted") {
    return access === "explicit_grant" ? "write_granted" : "write_own_namespace";
  }
  return "read_shared";
}

export function decideContentFamilyRoute(input: {
  method: string;
  path: string;
  actor: CoforgeMemoryActor;
}): RoutePolicyDecision {
  const mapped = mapMemoryActor({ actor: input.actor, binding: DEFAULT_BINDING });
  const normalized = normalizeOpenVikingPath(input.path);
  if (!normalized.ok) return normalized;
  const method = input.method.toUpperCase();
  const route = findContentFamilyRoute(method, normalized.path);
  const classification = classifyOpenVikingRoute(
    { method, path: normalized.path },
    CONTENT_FAMILY_GATEWAY_CATALOG,
  );
  if (!route || classification !== "data-plane") {
    return { ok: false, failure: sanitizeOpenVikingTransportFailure("route_denied") };
  }
  if (!contentFamilyAllowsActor(route, input.actor.kind)) {
    return { ok: false, failure: sanitizeOpenVikingTransportFailure("capability_denied") };
  }
  return decideRoutePolicy({
    method,
    path: normalized.path,
    access: mapped.access,
    requiredCapability: capabilityRequiredByContentFamilyRoute(route, mapped.access),
    catalog: CONTENT_FAMILY_GATEWAY_CATALOG,
  });
}
